# redis-json-memoize

Caches the JSON response of a provided promise into the provided Redis. Ideal for caching responses from database calls in your API.

If you are looking to reap the benefits of Redis caching in your API, this library provides a simple and easy-to-use solution.

Compatible with both [ioredis](https://www.npmjs.com/package/ioredis) and [node redis](https://www.npmjs.com/package/redis).

For more info on Redis: https://redis.io/topics/introduction

## Install

`npm install --save redis-json-memoize`

## Usage Examples

### Providing Redis instance directly

```
const Redis = require('ioredis');
const redisMemoize = require('redis-json-memoize');
const config = require('../../config');
const UserModel = require('../models/user'); // Could be from Mongoose, Sequelize etc

const redisInstance = new Redis(config.redisUrl);

function getUserByName(userName) {
	return UserModel.find({ name: userName });
}

module.exports = redisMemoize.memoize(getUserByName, { redis: redisInstance });
```

### Initializing module with Redis instance

```
const Redis = require('ioredis');
const redisMemoize = require('redis-json-memoize');
const config = require('../../config');
const UserModel = require('../models/user'); // Could be from Mongoose, Sequelize etc

const redisInstance = new Redis(config.redisUrl);

redisMemoize.initialize({
	redis: redisInstance,
});

function getUserByName(userName) {
	return UserModel.find({ name: userName });
}

module.exports = redisMemoize.memoize(getUserByName);
```

## API

### memoize (fn : Function, options: Object)
Returns a memoized version of the provided function.

- **fn** Provided function
	- Must return a promise
	- Should be named as specifically as possible (`fn.name` will be used to write the redis key for the cached response)
	- NOTE: it is not recommended that you use this module to memoize Express/Hapi request handlers. Redis keys are written using a combination of `fn.name` and the function inputs stringified. HTTP requests are large circular objects, so the memoization will not be effective

- **options**
	- **redis** This is where the Redis instance is provided. Compatible with both ioredis and node-redis.
	- **ttl** Sets the TTL (time to loss) for responses memoized from this function. NOTE: Redis TTL's are in seconds, not milliseconds.

### initialize (options: Object)
Initializes implementation of redis-json-memoize.
- **redis** Object. Required. A redis instance.
- **ttl** Number. TTL for cached data in your Redis. If not provided, a default is used.
- **disableLogs** Boolean. Defaults to false. If true, all logs from redis-json-memoize will be muted.
- **prefetchRatio** Number. Defaults to 0.7. Determines the time, as a ratio of TTL, at which cached data is marked as "stale". When Redis returns a "stale" object, it triggers a background refresh of that data.
- **startupTime** Number. Default 5 seconds. Determines how much time is allowed at startup for Redis to boot before the module begins memoizing provided functions.
- **promiseLibrary** Object. Default is native Promise. This gives you an option to provide Bluebird or another promise library if you feel the desire to do so.

## TODOS
 - Test coverage
 - Implement clearCache method