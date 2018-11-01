const _ = require('lodash');
const stableStringify = require('json-stable-stringify');

// Defaults
const DEFAULT_LOGS_DISABLED = false;
const DEFAULT_TTL = 60 * 5; // 5 minutes
const DEFAULT_PREFETCH_RATIO = 0.7;
const DEFAULT_CACHE_STARTUP_TIME = 5000; // 5 seconds
const DEFAULT_PROMISE_LIBRARY = Promise;

// Presets
let cacheObject = null;
let cacheTtl = DEFAULT_TTL;
let logsDisabled = DEFAULT_LOGS_DISABLED;
let cachePrefetchRatio = DEFAULT_PREFETCH_RATIO;
let cacheStartupTime = DEFAULT_CACHE_STARTUP_TIME;
let PromiseUtil = DEFAULT_PROMISE_LIBRARY;

// Stores
const memoizedFunctions = {};
const prefetchTimeouts = {};

/*
*	Private methods
*/

// Private log method prepends package name
// and is muted if logs are disabled
function log() {
	if (!logsDisabled) {
		const packageNameLog = '[node-redis-memoize]';
		const argumentsArray = _.values(arguments);
		const logOutput = [packageNameLog].concat(argumentsArray);
		console.log(logOutput);
	}
}

// Returns false if an invalid cache object is provided
function isValidCacheObject(cache) {
	return cache && !!cache.status;
}

// Verifies that a function can be memoized
function verifyFunctionCanBeMemoized(fn, ttl) {
	if (typeof fn !== 'function') {
		throw new Error(`Can only memoize memoize functions, not ${typeof fn}s`);
	}
	if (!fn.name) {
		throw new Error('Cannot memoize anonymous functions');
	}
	if (!(typeof ttl === 'number' && ttl > 0)) {
		throw new Error(`ttl for ${fn.name} must be of type number with value greater than 0, ${typeof ttl} ${ttl} is not valid.`);
	}
	if (memoizedFunctions[fn.name]) {
		throw new Error(`Cannot memoize two functions with the same name (${fn.name})`);
	}
	// @TODO verify function is thenable (ie that it returns a promise)
}

function isCacheActive() {
	return cache && cache.status === 'ready';
}

// Generates a cache key from a function and its arguments
function generateCacheKey(fn, args) {
	return `${fn.name}:${stableStringify(args)}`;
}

// Retrieves data from a cache key
// and converts it to JSON
function readFromCache(key) {
	return cache.get(key)
		.then((result) => {
			// Make sure we return cached data as json
			// (everything in Redis is a string 🙄)
			try {
				return JSON.parse(result);
			} catch (e) {
				log('Error parsing cache data');
				log(e);
			}
			return result;
		});
}

// This method marks cached data as "stale".
// When the client receives stale data, it triggers a prefetch
function markDataStale(key) {
	readFromCache(key)
		.then((results) => {
			if (results) {
				results[REQUEST_RESET_KEY] = true;
				writeToCache(key, results); // eslint-disable-line no-use-before-define
			}
		});
}

// Clears an existing refresh timeout (in-memory 😕)
// ie cancels our appointment to mark a cache key's data as "stale"
function clearPrefetchTimeout(key) {
	clearTimeout(prefetchTimeouts[key]);
	delete prefetchTimeouts[key];
}

// Sets a timeout to mark a cache key's data as stale,
// ie sets an appoinment to make a cache entry as "stale".
function setPrefetchTimeout(key, ttl) {
	const prefetchTimeout = ttl * cachePrefetchRatio * 1000;
	// If there is already an appoinment to mark the data stale,
	// this method cancels that appointment and move it forward
	if (prefetchTimeouts[key]) {
		clearPrefetchTimeout(key);
	}
	prefetchTimeouts[key] = setTimeout(() => markDataStale(key), prefetchTimeout);
}

// Writes data to a cache key
function writeToCache(key, data, ttl) {
	const cacheData = typeof data === 'object' ? JSON.stringify(data) : data;
	// If cache is not functioning,
	// we do not attempt to write data to cache
	if (!isCacheActive()) {
		// FYI cache.set returns a string 'OK' when successful
		return 'Cache is not active.';
	}
	// Set appointment to mark this data as "stale"
	if (ttl) {
		return cache.set(key, cacheData, 'ex', ttl)
			.then(() => setPrefetchTimeout(key, ttl));
	}
	// Sets the TTL for the cache key, IE when it is to be entirely scrubbed from Redis
	return cache.ttl(key) // cache.set will remove item's TTL if one is not specified
		.then((itemTtl) => {
			if (itemTtl > 0) {
				return cache.set(key, cacheData, 'ex', itemTtl); // preserves existing TTL
			}
			log(`WARNING: saved item to cache with no TTL - key ${key}`);
			return cache.set(key, cacheData);
		});
}

// Deletes a key from the cache
function deleteFromCache(key) {
	clearPrefetchTimeout(key);
	if (!isCacheActive()) {
		return 'Cache is not active.';
	}
	return cache.del(key);
}

// Tells us if cache data is "stale"
function shouldRefresh(data) {
	return !!data[REQUEST_RESET_KEY];
}

/*
* Public methods
*/

function memoize(thenableFunction, { cache = cacheObject, ttl = cacheTtl } = {}) {
	if (!cache) {
		log('No cache object provided. You must either initialize with a cache object or provide one to memoize.');
		return thenableFunction;
	}
	// Validate provided function
	verifyFunctionCanBeMemoized(thenableFunction, ttl);
	// Create memoized version of input function
	function memoizedMethod() {
		// Sets cache key based on function name and arguments being supplied
		const key = generateCacheKey(thenableFunction, arguments);
		const argumentsArray = _.values(arguments);
		// If cache is down at the moment, bypass and report to sentry
		if (!isCacheActive()) {
			const logMessage = `Bypassing cache for: ${thenableFunction.name}`;
			log(`Bypassing cache for: ${thenableFunction.name}`);
			return thenableFunction.apply(null, argumentsArray);
		}
		// Check if we already have data for this method/with these arguments
		return readFromCache(key)
			.then((data) => {
				if (!data) {
					// if cache is empty, populate it while returning data
					return thenableFunction.apply(null, argumentsArray)
						.then((results) => {
							// When data is fetched directly from DB,
							// return DB data to client
							// and asynchronously store it to the cache
							writeToCache(key, results, ttl);
							return results;
						})
						.catch((error) => {
							// Asynchronously delete cache for this method
							// if there is an error (to be safe)
							deleteFromCache(key);
							return PromiseUtil.reject(error);
						});
				}
				// If cache data is "stale",
				// return cached data but also initiate a prefetch
				if (shouldRefresh(data)) {
					// async
					thenableFunction.apply(null, argumentsArray)
						.then((results) => {
							writeToCache(key, results, ttl);
						});
					//
				}
				return data;
			})
			.catch((error) => {
				log('Cache failure!');
				log(error);
				return thenableFunction.apply(null, argumentsArray); // if cache is failing, bypass it
			});
	}
	// Clears all values cached from this particular memoized method
	// providing it with an locatorString will clear only cache keys that contain that locatorString
	memoizedMethod.clearCache = function clearMemoizedFunctionCache(locatorString) {
		const glob = `${thenableFunction.name}:*${locatorString ? locatorString + '*' : ''}`;
		// Redis KEYS command is unperformant,
		// using because clearCache method should rarely be called
		// (only on admin events) and never blocking
		return cache.keys(glob)
			.then((keys) => {
				keys.forEach(deleteFromCache);
			});
	};

	// Logs so that devs can see whether memoization was successful
	setTimeout(() => {
		if (isCacheActive()) {
			// If cache booted successfuly,
			// we assume that memoization was successsful too
			log(`Memoized function ${thenableFunction.name} with ttl of ${ttl}`);
		} else {
			// If the cache is not up and running after startup period,
			// there is *probably* something wrong, but we can't be 100% sure
			log(`(Probably) failed to Memoize function ${thenableFunction.name}`);
		}
	}, cacheStartupTime);

	memoizedFunctions[thenableFunction.name] = memoizedMethod;
	return memoizedMethod;
}

// If you don't pass any methods in, it will clear all data from all memoized functions
// if you do pass methods in, it will clear caches only for the named functions
// in additon, if you specify a key (in locators), it will pass that key into each clearCache call
export function clearCache({ methods, locators = [null] } = {}) {
	if (isCacheActive()) { // If cache is dead, nothing to clear
		const methodsToClear = methods ? methods.map(name => memoizedFunctions[name]) : _.values(memoizedFunctions);
		methodsToClear.forEach((method) => {
			if (!method || !method.clearCache) {
				return log(`Cannot clear cache for method name ${method.name}`);
			}
			locators.forEach((locator) => {
				method.clearCache(locator);
			});
		});
	}
}

function initialize({
	cache,
	ttl = DEFAULT_TTL,
	disableLogs = DEFAULT_LOGS_DISABLED,
	prefetchRatio = DEFAULT_PREFETCH_RATIO,
	startupTime = DEFAULT_CACHE_STARTUP_TIME,
	promiseLibrary = DEFAULT_PROMISE_LIBRARY,
}) {
	if (!cache) {
		throw new Error('No cache object provided to setCache');
	}
	if (!isValidCacheObject(cache)) {
		throw new Error('Invalid cache object provided to setCache');
	}
	cacheObject = cache;
	cacheTtl = ttl;
	logsDisabled = disableLogs;
	cachePrefetchRatio = prefetchRatio;
	cacheStartupTime = startupTime;
	PromiseUtil = promiseLibrary;
	log('Redis memoization initialized!');
}

module.exports = {
	clearCache,
	initialize,
	memoize,
};
