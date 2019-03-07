const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const EventEmitter = require('events');
const stream = require('stream');
const axios = require('axios');
const debug = require('debug')('yacdn:cache');

const redis = require('./redis');
const config = require('../config');

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

/*
Cache#retrieve (url, maxAge = 1 day)
returns {
	size: Number,
	data: Stream,
	contentType: string
}
*/

module.exports = class Cache {
	constructor(path = config.cacheDir, name = 'cache') {
		this.path = path;
		this.name = name;
	}

	async retrieve(url, maxAge = 24 * 60 * 60 * 1000) { /* returns stream */
		const hash = crypto.createHash('sha256')
			.update(url)
			.digest('hex');

		const filePath = path.join(this.path, hash) + '.bin';

		const created = Number(await redis.zscore(`cache:${this.name}`, hash));

		if(Date.now() - created > maxAge) {
			debug(url, 'not in cache');
			// file not in cache or too old

			const response = await axios.get(url, {
				responseType: 'stream'
			});

			const meta = {
				contentLength: response.headers['content-length'],
				contentType: response.headers['content-type']
			};

			const data = new stream.PassThrough();
			response.data.pipe(data);

			response.data.pipe(fs.createWriteStream(filePath));

			setTimeout(async () => {
				await writeFile(`${filePath}.json`, JSON.stringify(meta));

				await redis.zadd(`cache:${this.name}`, Date.now(), hash);
			}, 0);

			return {
				...meta,
				data
			};
		} else {
			debug(url, 'already in cache');

			const meta = JSON.parse(await readFile(`${filePath}.json`, 'utf8'));

			return {
				...meta,
				data: fs.createReadStream(filePath)
			};
		}
	}

	async remove() {

	}
};