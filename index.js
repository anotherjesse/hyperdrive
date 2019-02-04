const path = require('path')
const { EventEmitter } = require('events')

const collect = require('stream-collector')
const thunky = require('thunky')
const unixify = require('unixify')
const raf = require('random-access-file')
const mutexify = require('mutexify')
const duplexify = require('duplexify')
const sodium = require('sodium-universal')
const through = require('through2')
const pump = require('pump')

const hypercore = require('hypercore')
const hypertrie = require('hypertrie')
const coreByteStream = require('hypercore-byte-stream')

const Stat = require('./lib/stat')
const errors = require('./lib/errors')
const messages = require('./lib/messages')

class Hyperdrive extends EventEmitter {
  constructor (storage, key, opts) {
    super()

    if (isObject(key)) {
      opts = key
      key = null
    }
    if (!opts) opts = {}

    this.key = null
    this.discoveryKey = null
    this.live = true
    this.latest = !!opts.latest

    this._storages = defaultStorage(this, storage, opts)

    this.metadataFeed = opts.metadataFeed || hypercore(this._storages.metadata, key, {
      secretKey: opts.secretKey,
      sparse: opts.sparseMetadata,
      createIfMissing: opts.createIfMissing,
      storageCacheSize: opts.metadataStorageCacheSize,
      valueEncoding: 'binary'
    })
    this._db = opts.db
    this.contentFeed = opts.contentFeed || null
    this.storage = storage

    this._contentOpts = null
    this._contentFeedLength = null
    this._contentFeedByteLength = null
    this._lock = mutexify()

    this.ready = thunky(this._ready.bind(this))
    this.contentReady = thunky(this._contentReady.bind(this))

    this.ready(onReady)
    this.contentReady(onContentReady)

    const self = this

    function onReady (err) {
      if (err) return self.emit('error', err)
      self.emit('ready')
    }

    function onContentReady (err) {
      if (err) return self.emit('error', err)
      self.emit('content')
    }
  }

  get version () {
    // TODO: The trie version starts at 1, so the empty hyperdrive version is also 1. This should be 0.
    return this._db.version
  }

  get writable () {
    return this.metadataFeed.writable && this.contentFeed.writable
  }

  _ready (cb) {
    const self = this

    this.metadataFeed.on('error', onerror)
    this.metadataFeed.on('append', update)

    this.metadataFeed.ready(err => {
      if (err) return cb(err)

      const keyPair = this.metadataFeed.secretKey ? contentKeyPair(this.metadataFeed.secretKey) : {}
      this._contentOpts = contentOptions(this, keyPair.secretKey)

      /**
       * If a db is provided as input, ensure that a contentFeed is also provided, then return (this is a checkout).
       * If the metadata feed is writable:
       *    If the metadata feed has length 0, then the db should be initialized with the content feed key as metadata.
       *    Else, initialize the db without metadata and load the content feed key from the header.
       * If the metadata feed is readable:
       *    Initialize the db without metadata and load the content feed key from the header.
       */
      if (this._db) {
        if (!this.contentFeed || !this.metadataFeed) return cb(new Error('Must provide a db and both content/metadata feeds'))
        return done(null)
      } else if (this.metadataFeed.writable && !this.metadataFeed.length) {
        initialize(keyPair)
      } else {
        restore(keyPair)
      }
    })

    /**
     * The first time the hyperdrive is created, we initialize both the db (metadata feed) and the content feed here.
     */
    function initialize (keyPair) {
      self.contentFeed = hypercore(self._storages.content, keyPair.publicKey, self._contentOpts)
      self.contentFeed.on('error', function (err) {
        self.emit('error', err)
      })
      self.contentFeed.ready(function (err) {
        if (err) return cb(err)

        self._db = hypertrie(null, {
          feed: self.metadataFeed,
          metadata: self.contentFeed.key,
          valueEncoding: messages.Stat
        })

        self._db.ready(function (err) {
          if (err) return cb(err)
          return done(null)
        })
      })
    }

    /**
     * If the hyperdrive has already been created, wait for the db (metadata feed) to load.
     * If the metadata feed is writable, we can immediately load the content feed from its private key.
     * (Otherwise, we need to read the feed's metadata block first)
     */
    function restore (keyPair) {
      self._db = hypertrie(null, {
        feed: self.metadataFeed,
        valueEncoding: messages.Stat
      })
      if (self.metadataFeed.writable) {
        self._db.ready(err => {
          if (err) return done(err)
          self._ensureContent(done)
        })
      } else {
        self._db.ready(done)
      }
    }

    function done (err) {
      if (err) return cb(err)
      self.key = self.metadataFeed.key
      self.discoveryKey = self.metadataFeed.discoveryKey
      return cb(null)
    }

    function onerror (err) {
      if (err) self.emit('error', err)
    }

    function update () {
      self.emit('update')
    }
  }

  _ensureContent (cb) {
    this._db.getMetadata((err, contentKey) => {
      if (err) return cb(err)

      this.contentFeed = hypercore(this._storages.content, contentKey, this._contentOpts)
      this.contentFeed.ready(err => {
        if (err) return cb(err)

        this._contentFeedByteLength = this.contentFeed.byteLength
        this._contentFeedLength = this.contentFeed.length

        this.contentFeed.on('error', err => this.emit('error', err))
        return cb(null)
      })
    })
  }

  _contentReady (cb) {
    this.ready(err => {
      if (err) return cb(err)
      if (this.contentFeed) return cb(null)
      this._ensureContent(cb)
    })
  }

  createReadStream (name, opts) {
    if (!opts) opts = {}

    name = unixify(name)

    const stream = coreByteStream({
      ...opts,
      highWaterMark: opts.highWaterMark || 64 * 1024 
    })

    this.contentReady(err => {
      if (err) return stream.destroy(err)

      this._db.get(name, (err, st) => {
        if (err) return stream.destroy(err)
        if (!st) return stream.destroy(new errors.FileNotFound(name))

        st = st.value

        let byteOffset = (opts.start) ? st.byteOffset + opts.start : st.byteOffset
        let byteLength = (opts.start) ? st.size - opts.start : st.size

        stream.start({
          feed: this.contentFeed,
          blockOffset: st.offset,
          blockLength: st.blocks,
          byteOffset,
          byteLength
        })
      })
    })

    return stream
  }

  createDirectoryStream (name, opts) {
    if (!opts) opts = {}

    name = unixify(name)

    const proxy = duplexify.obj()
    proxy.setWritable(false)

    this.ready(err => {
      if (err) return
      let stream = pump(
        this._db.createReadStream(name, opts),
        through.obj((chunk, enc, cb) => {
          return cb(null, {
            path: chunk.key,
            stat: new Stat(chunk.value)
          })
        })
      )
      proxy.setReadable(stream)
    })

    return proxy
  }

  createWriteStream (name,  opts) {
    if (!opts) opts = {}

    name = unixify(name)

    const self = this
    const proxy = duplexify()
    var release = null
    proxy.setReadable(false)

    // TODO: support piping through a "split" stream like rabin

    this.contentReady(err => {
      if (err) return proxy.destroy(err)
      this._lock(_release => {
        release = _release
        return append()
      })
    })

    return proxy

    function append (err) {
      if (err) proxy.destroy(err)
      if (proxy.destroyed) return release()

      // No one should mutate the content other than us
      let byteOffset = self.contentFeed.byteLength
      let offset = self.contentFeed.length

      self.emit('appending', name, opts)

      // TODO: revert the content feed if this fails!!!! (add an option to the write stream for this (atomic: true))
      const stream = self.contentFeed.createWriteStream()

      proxy.on('close', done)
      proxy.on('finish', done)

      proxy.setWritable(stream)
      proxy.on('prefinish', function () {
        var st = Stat.file({
          ...opts,
          size: self.contentFeed.byteLength - byteOffset,
          blocks: self.contentFeed.length - offset,
          offset: offset,
          byteOffset: byteOffset,
        })

        proxy.cork()
        self._db.put(name, st, function (err) {
          if (err) return proxy.destroy(err)
          self.emit('append', name, opts)
          proxy.uncork()
        })
      })
    }

    function done () {
      proxy.removeListener('close', done)
      proxy.removeListener('finish', done)
      self._contentFeedLength = self.contentFeed.length
      self._contentFeedByteLength = self.contentFeed.byteLength
      release()
    }
  }

  readFile (name, opts, cb) {
    if (typeof opts === 'function') return this.readFile(name, null, opts)
    if (typeof opts === 'string') opts = {encoding: opts}
    if (!opts) opts = {}

    name = unixify(name)

    collect(this.createReadStream(name, opts), function (err, bufs) {
      if (err) return cb(err)
      let buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs)
      cb(null, opts.encoding && opts.encoding !== 'binary' ? buf.toString(opts.encoding) : buf)
    })
  }

  writeFile (name, buf, opts, cb) {
    if (typeof opts === 'function') return this.writeFile(name, buf, null, opts)
    if (typeof opts === 'string') opts = {encoding: opts}
    if (!opts) opts = {}
    if (typeof buf === 'string') buf = Buffer.from(buf, opts.encoding || 'utf-8')
    if (!cb) cb = noop

    name = unixify(name)

    let bufs = split(buf) // split the input incase it is a big buffer.
    let stream = this.createWriteStream(name, opts)
    stream.on('error', cb)
    stream.on('finish', cb)
    for (let i = 0; i < bufs.length; i++) stream.write(bufs[i])
    stream.end()
  }

  mkdir (name, opts, cb) {
    if (typeof opts === 'function') return this.mkdir(name, null, opts)
    if (typeof opts === 'number') opts = {mode: opts}
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = unixify(name)

    this.ready(err => {
      if (err) return cb(err)
      let st = Stat.directory({
        ...opts,
        offset: this._contentFeedLength,
        byteOffset: this._contentFeedByteLength
      })
      this._db.put(name, st, cb)
    })
  }

  _statDirectory (name, opts, cb) {
    const ite = this._db.iterator(name)
    ite.next((err, st) => {
      if (err) return cb(err)
      if (name !== '/' && !st) return cb(new errors.FileNotFound(name))
      st = Stat.directory()
      return cb(null, st)
    })
  }

  lstat (name, opts, cb) {
    if (typeof opts === 'function') return this.lstat(name, null, opts)
    if (!opts) opts = {}
    name = unixify(name)

    this.ready(err => {
      if (err) return cb(err)

      this._db.get(name, opts, (err, node) => {
        if (err) return cb(err)
        if (!node) return this._statDirectory(name, opts, cb)
        cb(null, new Stat(node.value))
      })
    })
  }

  stat (name, opts, cb) {
    if (typeof opts === 'function') return this.stat(name, null, opts)
    if (!opts) opts = {}

    this.lstat(name, opts, cb)
  }

  access (name, opts, cb) {
    if (typeof opts === 'function') return this.access(name, null, opts)
    if (!opts) opts = {}
    name = unixify(name)

    this.stat(name, opts, err => {
      cb(err)
    })
  }

  exists (name, opts, cb) {
    if (typeof opts === 'function') return this.exists(name, null, opts)
    if (!opts) opts = {}

    this.access(name, opts, err => {
      cb(!err)
    })
  }

  readdir (name, opts, cb) {
    if (typeof opts === 'function') return this.readdir(name, null, opts)
    name = unixify(name)

    let dirStream = this.createDirectoryStream(name, opts)
    this._db.list(name, (err, list) => {
      if (err) return cb(err)
      return cb(null, list.map(st => name === '/' ? st.key : path.basename(name, st.key)))
    })
  }

  _del (name, cb) {
    this.ready(err => {
      if (err) return cb(err)
      this._db.del(name, (err, node) => {
        if (err) return cb(err)
        if (!node) return cb(new errors.FileNotFound(name))
        // TODO: Need to check if it's a directory, and the directory was not found
        return cb(null)
      })
    })
  }

  unlink (name, cb) {
    name = unixify(name)
    this._del(name, cb || noop)
  }

  rmdir (name, cb) {
    if (!cb) cb = noop
    name = unixify(name)

    let stream = this._db.iterator(name)
    stream.next((err, val) => {
      if (err) return cb(err)
      if (val) return cb(new errors.DirectoryNotEmpty(name))
      self._del(name, cb)
    })
  }

  replicate (opts) {
    if (!opts) opts = {}
    opts.expectedFeeds = 2

    const stream = this.metadataFeed.replicate(opts)

    this.contentReady(err => {
      if (err) return stream.destroy(err)
      if (stream.destroyed) return
      this.contentFeed.replicate({
        live: opts.live,
        download: opts.download,
        upload: opts.upload,
        stream: stream
      })
    })

    return stream
  }

  checkout (version, opts) {
    const versionedTrie = this._db.checkout(version) 
    opts = {
      ...opts,
      metadataFeed: this.metadataFeed,
      contentFeed: this.contentFeed,
      db: versionedTrie,
    }
    return new Hyperdrive(this.storage, this.key, opts)
  }

  _closeFile (fd, cb) {
    // TODO: implement
    process.nextTick(cb, null)
  }

  close (fd, cb) {
    if (typeof fd === 'number') return this._closeFile(fd, cb || noop)
    else cb = fd
    if (!cb) cb = noop

    this.contentReady(err => {
      if (err) return cb(err)
      this.metadataFeed.close(err => {
        if (!this.contentFeed) return cb(err)
        this.contentFeed.close(cb)
      })
    })
  }

  watch (name, onchange) {
    name = unixify(name)
    return this._db.watch(name, onchange)
  }
}

module.exports = Hyperdrive

function isObject (val) {
  return !!val && typeof val !== 'string' && !Buffer.isBuffer(val)
}

function wrap (self, storage) {
  return {
    metadata: function (name, opts) {
      return storage.metadata(name, opts, self)
    },
    content: function (name, opts) {
      return storage.content(name, opts, self)
    }
  }
}

function defaultStorage (self, storage, opts) {
  var folder = ''

  if (typeof storage === 'object' && storage) return wrap(self, storage)

  if (typeof storage === 'string') {
    folder = storage
    storage = raf
  }

  return {
    metadata: function (name) {
      return storage(path.join(folder, 'metadata', name))
    },
    content: function (name) {
      return storage(path.join(folder, 'content', name))
    }
  }
}

function contentOptions (self, secretKey) {
  return {
    sparse: self.sparse || self.latest,
    maxRequests: self.maxRequests,
    secretKey: secretKey,
    storeSecretKey: false,
    indexing: self.metadataFeed.writable && self.indexing,
    storageCacheSize: self.contentStorageCacheSize
  }
}

function contentKeyPair (secretKey) {
  var seed = Buffer.allocUnsafe(sodium.crypto_sign_SEEDBYTES)
  var context = Buffer.from('hyperdri', 'utf8') // 8 byte context
  var keyPair = {
    publicKey: Buffer.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES),
    secretKey: Buffer.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)
  }

  sodium.crypto_kdf_derive_from_key(seed, 1, context, secretKey)
  sodium.crypto_sign_seed_keypair(keyPair.publicKey, keyPair.secretKey, seed)
  if (seed.fill) seed.fill(0)

  return keyPair
}

function split (buf) {
  var list = []
  for (var i = 0; i < buf.length; i += 65536) {
    list.push(buf.slice(i, i + 65536))
  }
  return list
}

function noop () {}
