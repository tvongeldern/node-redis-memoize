# redis-json-memoize

Caches the response of a promise into the provided Redis.

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