/* eslint curly: 0 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const Koa = require('koa');
const Router = require('koa-router');
const send = require('koa-send');
const axios = require('axios');

const redis = require('./lib/redis');
const Cache = require('./lib/Cache');

const cache = new Cache();
const app = new Koa();
const router = new Router();
const config = require('./config.js');

async function download(uri, filename) {
	const response = await axios.get(uri, {
		responseType: 'stream'
	});

	const type = response.headers['content-type'];
	const length = response.headers['content-length'];
	console.log(`Downloading: ${uri} (${type}, ${length} bytes)`);

	await redis.incrby('download', length);

	const stream = response.data.pipe(fs.createWriteStream(filename));

	await new Promise(resolve => stream.on('close', resolve));
}

const access = util.promisify(fs.access);
const stat = util.promisify(fs.stat);

app.use(async (ctx, next) => {
	if (ctx.path === '/')
		return ctx.redirect('https://ovsoinc.github.io/yacdn.org');

	await next();
});

app.use(async (ctx, next) => {
	const startTime = Date.now();

	const servePath = '/serve/';

	if (!ctx.path.startsWith(servePath))
		return next();

	const n = await redis.incr('cdnhits');

	const url = ctx.path.slice(servePath.length);

	console.log(`serve#${n} url: ${url}`);
	console.log(`serve#${n} referer: ${ctx.request.headers.referer}`);

	// increment link counter
	await redis.zincrby('serveurls', 1, url);

	const {
		contentLength,
		contentType,
		data
	} = await cache.retrieve(url);

	console.log(`serve#${n} size: ${(contentLength / (1024 ** 2)).toFixed(2)} MB`);

	ctx.set('Content-Length', contentLength);
	ctx.set('Content-Type', contentType);
	ctx.body = data;

	await redis.incrby('cdndata', contentLength);

	const time = Date.now() - startTime;
	const speed = contentLength / (time / 1000);

	// await new Promise(resolve => data.once('end', resolve));

	console.log(`serve#${n} done, took ${time}ms`);
	console.log(`serve#${n} effective speed: ${(speed / (10 ** 6)).toFixed(2)} megabits/s`);
});

app.use(async (ctx, next) => {
	// const startTime = Date.now();

	const servePath = '/proxy/';

	if (!ctx.path.startsWith(servePath))
		return next();

	const n = await redis.incr('proxyhits');

	const url = ctx.path.slice(servePath.length) + '?' + ctx.querystring;

	console.log(`proxy#${n} url: ${url}`);
	console.log(`proxy#${n} referer: ${ctx.request.headers.referer}`);

	const response = await axios.get(url, {
		responseType: 'stream'
	});

	const size = Number(response.headers['content-length']);

	await redis.incrby('proxydata', size);

	console.log(`serve#${n} size: ${(size / (1024 ** 2)).toFixed(2)} MB`);

	ctx.set('Access-Control-Allow-Origin', '*');

	ctx.set('Content-Type', response.headers['content-type']);

	response.data.once('data', () => {
		console.log(`serve#${n} size: ${(size / (1024 ** 2)).toFixed(2)} MB`);
	});

	ctx.body = response.data;
});

app.use(async ctx => {
	const servePath = '/stats';

	/* istanbul ignore next */
	if (!ctx.path.startsWith(servePath))
		return;

	ctx.body = {
		cdnHits: Number(await redis.get('cdnhits')),
		cdnData: `${(Number(await redis.get('cdndata')) / (1024 ** 3)).toFixed(2)} GB`,
		proxyHits: Number(await redis.get('proxyhits')),
		proxyData: `${(Number(await redis.get('proxydata')) / (1024 ** 3)).toFixed(2)} GB`
	};
});

app.use(router.routes());

/* istanbul ignore next */
// Start the server, if running this script alone
if (require.main === module) {
	/* istanbul ignore next */
	app.listen(3000, () => {
		console.log('Server listening on port 3000...');
	});
}

module.exports = app;
