const Redis     = require('ioredis');
const RedisGCRA = require('../lib');
const sinon     = require('sinon');

describe('ioRedis-RedisGCRA', () => {
  before(() => {
    this.redis = new Redis({ db: 4 });
    this.redis.on('error', (err) => { throw err; });
    this.limiter = RedisGCRA({ redis: this.redis });
  });

  after(() => {
    return this.redis.quit();
  });

  beforeEach(() => {
    return this.redis.flushdb();
  });

  it('should not round your tokens', async () => {
    const opts = { key: 'testKey', burst: 1, rate: 1, period: 1000, cost: 1 };
    let result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(0);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);

    await new Promise((fulfill) => {
      setTimeout(fulfill, result.resetIn * 0.75); // wait 3/4 of the time
    });

    result = await this.limiter.limit(opts);
    result.limited.should.equal(true);
    result.remaining.should.equal(0);
    result.retryIn.should.be.within(100, 250);
    result.resetIn.should.be.within(100, 250);

    result = await this.limiter.peek(opts);
    result.limited.should.equal(true);
    result.remaining.should.equal(0);
    result.resetIn.should.be.within(100, 250);

    await new Promise((fulfill) => {
      setTimeout(fulfill, result.resetIn); // wait the rest of the time
    });

    result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(0);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);
  });

  it('should actually expire the key from redis', async () => {
    (await this.redis.exists('testKey')).should.equal(0);

    let peekResult = await this.limiter.peek({
      key: 'testKey', burst: 1, rate: 1, period: 500, cost: 1
    });
    peekResult.limited.should.equal(false);

    (await this.redis.exists('testKey')).should.equal(0);

    const opts = { key: 'testKey', burst: 1, rate: 1, period: 500, cost: 1 };
    const result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(0);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(490, 500);

    (await this.redis.exists('testKey')).should.equal(1);

    await new Promise((fulfill) => {
      setTimeout(fulfill, result.resetIn);
    });

    (await this.redis.exists('testKey')).should.equal(0);

    peekResult = await this.limiter.peek({
      key: 'testKey', burst: 1, rate: 1, period: 500, cost: 1
    });
    peekResult.limited.should.equal(false);

    (await this.redis.exists('testKey')).should.equal(0);
  });

  it('should perform basic limit and regen', async () => {
    const opts = { key: 'testKey', burst: 4, rate: 1, period: 500, cost: 2 };
    let result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(2);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);

    result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(0);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(1980, 2000);

    result = await this.limiter.limit(opts);
    result.limited.should.equal(true);
    result.remaining.should.equal(0);
    result.retryIn.should.be.within(870, 1000);
    result.resetIn.should.be.within(1970, 2000);

    const peekResult = await this.limiter.peek({
      key: 'testKey', burst: 2, rate: 1, period: 1000
    });
    peekResult.limited.should.equal(true);
    peekResult.remaining.should.equal(0);
    peekResult.resetIn.should.be.within(1960, 2000);

    await new Promise((fulfill) => {
      // let it regenerate 1 token
      setTimeout(fulfill, result.retryIn - 500);
    });

    result = await this.limiter.limit(opts);
    result.limited.should.equal(true);
    result.remaining.should.equal(1);
    result.retryIn.should.be.within(450, 1000);
    result.resetIn.should.be.within(1450, 1500);

    await new Promise((fulfill) => {
      // let it regenerate a 2nd token
      setTimeout(fulfill, result.retryIn);
    });

    result = await this.limiter.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(0);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(1990, 2000);
  });

  it('limits different keys independently', async () => {
    const results = await Promise.all([
      this.limiter.limit({ key: 'key1' }),
      this.limiter.limit({ key: 'key2' }),
      this.limiter.limit({ key: 'key1' })
    ]);

    const key2Result = results[1];
    key2Result.limited.should.equal(false);
    key2Result.remaining.should.equal(59);
    key2Result.retryIn.should.equal(0);
    key2Result.resetIn.should.be.within(990, 1000);

    let key1Result1 = results[0];
    let key1Result2 = results[2];
    // flip them if they executed in reverse order
    if (key1Result1.remaining < key1Result2.remaining) {
      key1Result1 = results[2];
      key1Result2 = results[0];
    }

    key1Result1.limited.should.equal(false);
    key1Result1.remaining.should.equal(59);
    key1Result1.retryIn.should.equal(0);
    key1Result1.resetIn.should.be.within(990, 1000);

    key1Result2.limited.should.equal(false);
    key1Result2.remaining.should.equal(58);
    key1Result2.retryIn.should.equal(0);
    key1Result2.resetIn.should.be.within(1980, 2000);
  });

  it('respects key prefixes and defaults', async () => {
    const prefixed = RedisGCRA({ redis: this.redis, keyPrefix: 'hello', cost: 5 });

    let key1Result = await this.limiter.limit({ key: 'key1' });
    key1Result.limited.should.equal(false);
    key1Result.remaining.should.equal(59);
    key1Result.retryIn.should.equal(0);
    key1Result.resetIn.should.be.within(990, 1000);

    let prefixedResult = await prefixed.limit({ key: 'key1' });
    prefixedResult.limited.should.equal(false);
    prefixedResult.remaining.should.equal(55);
    prefixedResult.retryIn.should.equal(0);
    prefixedResult.resetIn.should.be.within(4990, 5000);

    const reset1 = await prefixed.reset({ key: 'key1' });
    const reset2 = await prefixed.reset({ key: 'key1' });
    reset1.should.be.true();
    reset2.should.be.false();

    key1Result = await this.limiter.peek({ key: 'key1' });
    key1Result.limited.should.equal(false);
    key1Result.remaining.should.equal(59);
    key1Result.resetIn.should.be.within(980, 1000);

    prefixedResult = await prefixed.peek({ key: 'key1' });
    prefixedResult.limited.should.equal(false);
    prefixedResult.remaining.should.equal(60);
    prefixedResult.resetIn.should.equal(0);
  });

  const testCases = [
    {
      burst: 4500,
      rate: 75,
      period: 60000,
      cost: 1,
      repeat: 1,
      remaining: 4499,
      limited: false,
      retryIn: 0
    },
    {
      burst: 4500,
      rate: 75,
      period: 60000,
      cost: 1,
      repeat: 2,
      remaining: 4498,
      limited: false,
      retryIn: 0
    },
    {
      burst: 4500,
      rate: 75,
      period: 60000,
      cost: 2,
      repeat: 1,
      remaining: 4498,
      limited: false,
      retryIn: 0
    },
    {
      burst: 1000,
      rate: 100,
      period: 60000,
      cost: 200,
      repeat: 1,
      remaining: 800,
      limited: false,
      retryIn: 0
    },
    {
      burst: 1000,
      rate: 100,
      period: 60000,
      cost: 200,
      repeat: 4,
      remaining: 200,
      limited: false,
      retryIn: 0
    },
    {
      burst: 1000,
      rate: 100,
      period: 60000,
      cost: 200,
      repeat: 5,
      remaining: 0,
      limited: false,
      retryIn: 0
    },
    {
      burst: 1000,
      rate: 100,
      period: 60000,
      cost: 1,
      repeat: 137,
      remaining: 863,
      limited: false,
      retryIn: 0
    },
    {
      burst: 1000,
      rate: 100,
      period: 60000,
      cost: 1001,
      repeat: 1,
      remaining: 1000,
      limited: true,
      retryIn: Infinity
    }
  ];

  testCases.forEach((row, index) => {
    it(`calculates test case ${index} correctly`, async () => {
      const promises = [];
      for (let i=0; i<row.repeat-1; i++) {
        promises.push(this.limiter.limit({
          key: 'testCase',
          burst: row.burst,
          rate: row.rate,
          period: row.period,
          cost: row.cost
        }));
      }

      await Promise.all(promises);

      const finalResult = await this.limiter.limit({
        key: 'testCase',
        burst: row.burst,
        rate: row.rate,
        period: row.period,
        cost: row.cost
      });

      finalResult.remaining.should.equal(row.remaining);
      finalResult.limited.should.equal(row.limited);
      finalResult.retryIn.should.equal(row.retryIn);
    });
  });

  it('should not modify when using peek', async () => {
    (await Promise.all([
      this.limiter.peek({ key: 'key1' }),
      this.limiter.peek({ key: 'key1' }),
      this.limiter.peek({ key: 'key1' })
    ])).forEach((result) => {
      result.should.deepEqual({ limited: false, remaining: 60, resetIn: 0 });
    });

    await this.limiter.limit({ key: 'key1' });

    (await Promise.all([
      this.limiter.peek({ key: 'key1' }),
      this.limiter.peek({ key: 'key1' }),
      this.limiter.peek({ key: 'key1' })
    ])).forEach((result) => {
      result.limited.should.equal(false);
      result.remaining.should.equal(59);
      result.resetIn.should.be.within(980, 1000);
    });
  });

  it('monthly limit unlimited (-1) works as expected', async () => {
    const prefixed = RedisGCRA({ redis: this.redis, keyPrefix: 'test', cost: 1 });

    const opts = {
      key: 'user1', burst: 4, rate: 1, period: 500, cost: 1, monthlyLimit: -1
    };

    let result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(3);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(490, 500);
    result.monthlyRemaining.should.equal('unlimited');

    result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(2);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);
    result.monthlyRemaining.should.equal('unlimited');

    // check that the number of requests is properly set for the key
    const key = `test/user1:monthly_count:${RedisGCRA.getStartOfMonth()}`;
    const reqCount = await this.redis.get(key);
    reqCount.should.equal('2');
  });

  it('monthly limit limited (2500) works as expected', async () => {
    const prefixed = RedisGCRA({ redis: this.redis, keyPrefix: 'test', cost: 1 });

    const opts = {
      key: 'user1', burst: 4, rate: 1, period: 500, cost: 1, monthlyLimit: 2500
    };

    let result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(3);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(490, 500);
    result.monthlyRemaining.should.equal(2499);

    result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(2);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);
    result.monthlyRemaining.should.equal(2498);

    const key = `test/user1:monthly_count:${RedisGCRA.getStartOfMonth()}`;
    let reqCount = await this.redis.get(key);
    reqCount.should.equal('2');

    // test that we limit after n requests
    const opts2 = {
      key: 'user2', burst: 100, rate: 100, period: 500, cost: 1, monthlyLimit: 5
    };

    // foreach loop for 5 times
    [...Array(5).keys()].map(async (i) => {
      result = await prefixed.limit(opts2);
      result.limited.should.equal(false);
      result.monthlyRemaining.should.equal(4-i);
    });

    result = await prefixed.limit(opts2);
    result.limited.should.equal(true);
    result.monthlyRemaining.should.equal(0);

    // check that the number of requests is properly set for the key
    const key2 = `test/user2:monthly_count:${RedisGCRA.getStartOfMonth()}`;
    reqCount = await this.redis.get(key2);
    reqCount.should.equal('5');
  });

  it('monthly limit is reset after a month has passed', async () => {
    const clock = sinon.useFakeTimers(Date.now());
    const prefixed = RedisGCRA({ redis: this.redis, keyPrefix: 'test', cost: 1 });

    const opts = {
      key: 'user1', burst: 4, rate: 1, period: 500, cost: 1, monthlyLimit: 2500
    };

    let result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(3);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(490, 500);
    result.monthlyRemaining.should.equal(2499);

    result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(2);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(990, 1000);
    result.monthlyRemaining.should.equal(2498);

    let key = `test/user1:monthly_count:${RedisGCRA.getStartOfMonth()}`;
    let reqCount = await this.redis.get(key);
    reqCount.should.equal('2');

    // have a month pass
    clock.tick(1000 * 60 * 60 * 24 * 32);

    result = await prefixed.limit(opts);
    result.limited.should.equal(false);
    result.remaining.should.equal(3);
    result.retryIn.should.equal(0);
    result.resetIn.should.be.within(490, 500);
    result.monthlyRemaining.should.equal(2499);

    key = `test/user1:monthly_count:${RedisGCRA.getStartOfMonth()}`;
    reqCount = await this.redis.get(key);
    reqCount.should.equal('1');

    clock.restore();
  });

});
