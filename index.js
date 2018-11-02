const _ = require('lodash');
const stableStringify = require('json-stable-stringify');

// Constants
const REQUEST_RESET_KEY = '__stale__';

// Defaults
const DEFAULT_LOGS_DISABLED = false;
const DEFAULT_TTL = 60 * 5; // 5 minutes
const DEFAULT_PREFETCH_RATIO = 0.7;
const DEFAULT_CACHE_STARTUP_TIME = 5000; // 5 seconds
const DEFAULT_PROMISE_LIBRARY = Promise;

// Presets
let redisObject = null;
let redisTtl = DEFAULT_TTL;
let logsDisabled = DEFAULT_LOGS_DISABLED;
let redisPrefetchRatio = DEFAULT_PREFETCH_RATIO;
let redisStartupTime = DEFAULT_CACHE_STARTUP_TIME;
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
		console.log.apply(null, logOutput);
	}
}

// Returns false if an invalid cache object is provided
function isValidRedisObject(redis) {
	return redis && !!redis.status;
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

function isRedisActive(redis) {
	return redis && redis.status === 'ready';
}

// Generates a cache key from a function and its arguments
function generateRedisKey(fn, args) {
	return `${fn.name}:${stableStringify(args)}`;
}

// Retrieves data from a cache key
// and converts it to JSON
function readFromRedis({ redis, key }) {
	return redis.get(key)
		.then((result) => {
			// Make sure we return cached data as json
			// (everything in Redis is a string 🙄)
			try {
				return JSON.parse(result);
			} catch (e) {
				log('Error parsing redis data');
				log(e);
			}
			return result;
		});
}

// This method marks cached data as "stale".
// When the client receives stale data, it triggers a prefetch
function markDataStale({ redis, key }) {
	readFromRedis({ redis, key })
		.then((data) => {
			if (data) {
				data[REQUEST_RESET_KEY] = true;
				writeToRedis({ redis, key, data }); // eslint-disable-line no-use-before-define
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
function setPrefetchTimeout({ redis, key, ttl }) {
	const prefetchTimeout = ttl * redisPrefetchRatio * 1000;
	// If there is already an appoinment to mark the data stale,
	// this method cancels that appointment and move it forward
	if (prefetchTimeouts[key]) {
		clearPrefetchTimeout(key);
	}
	prefetchTimeouts[key] = setTimeout(() => {
		markDataStale({ redis, key });
	}, prefetchTimeout);
}

// Writes data to a cache key
function writeToRedis({ redis, key, data, ttl }) {
	const cacheData = typeof data === 'object' ? JSON.stringify(data) : data;
	// If redis is not functioning,
	// we do not attempt to write data to cache
	if (!isRedisActive(redis)) {
		// FYI redis.set returns a string 'OK' when successful
		return 'Redis is not active.';
	}
	// Set "appointment" to mark this data stale
	if (ttl) {
		return redis.set(key, cacheData, 'ex', ttl)
			.then(() => setPrefetchTimeout({ redis, key, ttl }));
	}
	// Sets the TTL for the cache key, IE when it is to be entirely scrubbed from Redis
	return redis.ttl(key) // cache.set will remove item's TTL if one is not specified
		.then((itemTtl) => {
			if (itemTtl > 0) {
				return redis.set(key, cacheData, 'ex', itemTtl); // preserves existing TTL
			}
			log(`WARNING: saved item to cache with no TTL - key ${key}`);
			return redis.set(key, cacheData);
		});
}

// Deletes a key from the cache
function deleteFromRedis({ redis, key }) {
	clearPrefetchTimeout(key);
	if (!isRedisActive(redis)) {
		return 'Cache is not active.';
	}
	return redis.del(key);
}

// Tells us if cache data is "stale"
function shouldRefresh(data) {
	return !!data[REQUEST_RESET_KEY];
}

/*
* Public methods
*/

function memoize(thenableFunction, { redis = redisObject, ttl = redisTtl } = {}) {
	if (!redis) {
		log('No cache object provided. You must either initialize with a cache object or provide one to memoize.');
		return thenableFunction;
	}
	// Validate provided function
	verifyFunctionCanBeMemoized(thenableFunction, ttl);
	// Create memoized version of input function
	function memoizedMethod() {
		// Sets cache key based on function name and arguments being supplied
		const key = generateRedisKey(thenableFunction, arguments);
		const argumentsArray = _.values(arguments);
		// If cache is down at the moment, bypass and report to sentry
		if (!isRedisActive(redis)) {
			log(`Bypassing cache for: ${thenableFunction.name}`);
			return thenableFunction.apply(null, argumentsArray);
		}
		// Check if we already have data for this method/with these arguments
		return readFromRedis({ redis, key })
			.then((redisResponse) => {
				if (!redisResponse) {
					// if cache is empty, populate it while returning data
					return thenableFunction.apply(null, argumentsArray)
						.then((data) => {
							// When data is fetched directly from DB,
							// return DB data to client
							// and asynchronously store it to the cache
							writeToRedis({ redis, key, data, ttl });
							return data;
						})
						.catch((error) => {
							// Asynchronously delete cache for this method
							// if there is an error (to be safe)
							deleteFromRedis({ redis, key });
							return PromiseUtil.reject(error);
						});
				}
				// If cache data is "stale",
				// return cached data but also initiate a prefetch
				if (shouldRefresh(redisResponse)) {
					// async
					thenableFunction.apply(null, argumentsArray)
						.then((data) => {
							writeToRedis({ redis, key, data, ttl });
						});
					//
				}
				return redisResponse;
			})
			.catch((error) => {
				log('Redis failure!');
				log(error);
				return thenableFunction.apply(null, argumentsArray); // if redis is failing, bypass it
			});
	}

	// Clears all values cached from this particular memoized method
	// providing it with an locatorString will clear only cache keys that contain that locatorString
	memoizedMethod.clearCache = function clearMemoizedFunctionCache(locatorString) {
		const glob = `${thenableFunction.name}:*${locatorString ? locatorString + '*' : ''}`;
		// Redis KEYS command is unperformant,
		// using because clearCache method should rarely be called
		// (only on admin events) and never blocking
		return redis.keys(glob)
			.then((keys) => {
				keys.forEach(key => deleteFromRedis({ redis, key }));
			});
	};

	// Log for visibility into whether memoization was successful at startup
	setTimeout(() => {
		if (isRedisActive(redis)) {
			// If cache booted successfuly,
			// we assume that memoization was successsful too
			log(`Memoized function ${thenableFunction.name} with ttl of ${ttl}`);
		} else {
			// If the cache is not up and running after startup period,
			// there is *probably* something wrong, but we can't be 100% sure
			log(`(Probably) failed to Memoize function ${thenableFunction.name}`);
		}
	}, redisStartupTime);

	memoizedFunctions[thenableFunction.name] = memoizedMethod;
	return memoizedMethod;
}


function clearCache() {

}

function initialize({
	redis,
	ttl = DEFAULT_TTL,
	disableLogs = DEFAULT_LOGS_DISABLED,
	prefetchRatio = DEFAULT_PREFETCH_RATIO,
	startupTime = DEFAULT_CACHE_STARTUP_TIME,
	promiseLibrary = DEFAULT_PROMISE_LIBRARY,
} = {}) {
	if (!redis) {
		throw new Error('No redis object provided to setCache');
	}
	if (!isValidRedisObject(redis)) {
		throw new Error('Invalid redis object provided to setCache');
	}
	redisObject = redis;
	redisTtl = ttl;
	logsDisabled = disableLogs;
	redisPrefetchRatio = prefetchRatio;
	redisStartupTime = startupTime;
	PromiseUtil = promiseLibrary;
	log('Redis memoization initialized!');
}

module.exports = {
	clearCache,
	initialize,
	memoize,
};
