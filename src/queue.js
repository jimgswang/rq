'use strict';

var redis = require('redis'),
    Task = require('./task'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    async = require('async'),
    uuid = require('node-uuid'),
    config = require('../config'),
    _ = require('lodash'),
    utils = require('./utils'),
    QueueErrors = require('./errors')

;

/** 
 * Make a new redis queue
 * @constructor
 * @param {String} queueName - the name of the queue
 * @param {Object} options - Hash of options
 *                            .host: hostname of redis server
 *                            .port: port server listening on
 */
function Rq(queueName, options) {

  var self = this
  ;

  this.host = options.host || '127.0.0.1';
  this.port = options.port || 6327;
  this.queue = queueName;
  this._retries = options.retry || 0;

  this._lockToken = uuid.v4();
  this._prefix = 'rq:' + queueName + ':';

  // Client for normal commands
  this._nbclient = redis.createClient(this.port, this.host);
  // Blocking client for BRLPOPRPUSH command
  this._bclient = redis.createClient(this.port, this.host);

  this.keys = {
    id : this._prefix + 'id',
    waiting : this._prefix + 'waiting',
    working : this._prefix + 'working',
    completed: this._prefix + 'completed'
  };

  this._nbclient.on('error', function(err) {
    self.emit('error', err);
  });

  this._bclient.on('error', function(err) {
    self.emit('error', err);
  });

  EventEmitter.call(this);
}

util.inherits(Rq, EventEmitter);

/**
 * Add new task to the queue
 * @param {Object} data - the hash associated with queue'd task
 * @param {Function} [callback] - the callback to execute
 */
Rq.prototype.enqueue = function (data, callback) {

  var self = this,
      cb = utils.optCallback(callback)
  ;
  
  async.waterfall([
    function(callback) {
      self._nbclient.incr(self.keys.id, callback);
    },
    function(id, callback) {
      self._nbclient.multi()
        .lpush(self.keys.waiting, id)
        .hmset(self.getKeyForId(id), data)
        .exec(callback);
    },
  ], function(err, result) {
    if(err) {
      self.emit('error', err); 
    }
    cb(err, result);
  });
};


/**
 * Get the next task in queue and process it
 * @param {Function} handler - the function to process the task,
 *                             it receives a task param
 */
Rq.prototype.dequeue = function(handler) {

  if(typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }

  var self = this,
      taskId
  ;

  self._handler = handler;

  async.waterfall([
    function(callback) {
      // block until we get next task
      self._bclient.brpoplpush(self.keys.waiting, self.keys.working, 0, callback);
    },
    function(id, callback) {
      taskId = id;
      self.lock(id, false, callback);
    },
    function(result, callback) {
      if(self._isLocked(result)) {
        self._nbclient.hgetall(self.getKeyForId(taskId), callback);
      }
      else {
        callback(QueueErrors.couldNotLock(taskId));
      }
    },
    function(data, callback) {

      var task = new Task(self, taskId, data);
      callback(null, task);
    }
  ], function(err, task) {

    if(err) {
      self.emit('error', err);
    } 
    else {
      handler(task);
    }
  });
};


/** 
 * Get the redis key for a task id
 * @param {Number} id - the task id
 * @returns {String} the redis key
 */
Rq.prototype.getKeyForId = function(id) {
  return this._prefix + id;
};


/**
 * Acquire  a lock for a task id
 * @param {Number} id - the task id
 * @param {Function} [callback] - callback to execute
 */
Rq.prototype.lock = function(id, renew, callback) {

  var key = this.getKeyForId(id) + ':lock',
      self = this,
      cb = utils.optCallback(callback),
      args = [key, self._lockToken, 'PX', config.lockTime]
  ;

  if(!renew) {
    args.push('NX');
  }

  clearTimeout(self.lockTimeout);
  self._nbclient.set(args, function(err, res) {

    if(self._isLocked(res)) {

      self.lockTimeout = setTimeout(function() {
        self.lock(id, true);
      }, config.lockTime / 2);
    }

    else {
      self.emit('error', QueueErrors.couldNotLock(id));
    }

    cb(err, res);
  });
};


/**
 * Check redis response if lock was acquired
 * @api private
 * @param {String} response - The response from redis
 * @returns {Boolean} - True if successful
 */
Rq.prototype._isLocked = function(response) {

  return response === 'OK';
};

/**
 * Release a lock for a task id
 * LUA script from http://redis.io/commands/SET
 * @param {Number} id - the task id
 * @param {Function} [callback] - callback to execute
 */
Rq.prototype.unlock = function(id, callback) {
  var script = 'if redis.call("get",KEYS[1]) == ARGV[1] ' +
               'then ' +
                 'return redis.call("del", KEYS[1]) ' +
               'else ' +
                 'return 0 ' + 
               'end',
      cb = utils.optCallback(callback)
  ;

  clearTimeout(this.lockTimeout);
  this._nbclient.eval(script, 1, this.getKeyForId(id) + ':lock', this._lockToken, cb);

};

module.exports = exports = Rq;
