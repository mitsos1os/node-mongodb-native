import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { debugOptions } from './utils';
import { parseHeader, opcodes, MESSAGE_HEADER_SIZE } from '../wireprotocol/shared';
import { Response } from './commands';
import { BinMsg } from './msg';
import { MongoError, MongoNetworkError } from '../error';
import { Buffer as SafeBuffer } from 'safe-buffer';
import { ConnectionInterface } from '../../../interfaces/connection';

const OP_COMPRESSED = opcodes.OP_COMPRESSED;
const OP_MSG = opcodes.OP_MSG;

// TS-TODO
const decompress = require('../wireprotocol/compression').decompress;
const Logger = require('./logger');

// types
import { Socket } from 'net';
import { BSON } from 'bson';

let _id = 0;

const DEFAULT_MAX_BSON_MESSAGE_SIZE = 1024 * 1024 * 16 * 4;
const DEBUG_FIELDS = [
  'host',
  'port',
  'size',
  'keepAlive',
  'keepAliveInitialDelay',
  'noDelay',
  'connectionTimeout',
  'socketTimeout',
  'ssl',
  'ca',
  'crl',
  'cert',
  'rejectUnauthorized',
  'promoteLongs',
  'promoteValues',
  'promoteBuffers',
  'checkServerIdentity'
];

let connectionAccountingSpy: any = undefined;
let connectionAccounting = false;
let connections: any = {};

export interface SocketOptions {
  host: string;
  port: number;
  bson: BSON;
  tag?: unknown;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  connectionTimeout?: number;
  socketTimeout?: number;

  maxBsonMessageSize?: number;
  promoteLongs?: boolean;
  promoteValues?: boolean;
  promoteBuffers?: boolean;
}

type DestroyCallback = (err: Error|null, result: null) => any;

/**
 * A class representing a single connection to a MongoDB server
 *
 * @fires Connection#connect
 * @fires Connection#close
 * @fires Connection#error
 * @fires Connection#timeout
 * @fires Connection#parseError
 * @fires Connection#message
 */
export class Connection extends EventEmitter implements ConnectionInterface {
  id: number;
  logger: any; // TS-TODO
  bson: BSON;
  tag?: unknown; // TS-TODO
  host: string;
  port: number;
  keepAlive: boolean;
  keepAliveInitialDelay: number;
  connectionTimeout: number;
  socketTimeout: number;
  maxBsonMessageSize: number;
  responseOptions: {
    promoteLongs: boolean;
    promoteValues: boolean;
    promoteBuffers: boolean;
  };

  // state
  flushing: boolean;
  queue: unknown[]; // TS-TODO
  writeStream: unknown; // TS-TODO
  destroyed: boolean;
  hashedName: string;
  workItems: unknown[];

  // Parsing types
  bytesRead: number = 0;
  sizeOfMessage: number = 0;
  buffer: Buffer|null|undefined;
  stubBuffer: Buffer|null|undefined;

  /**
   * Creates a new Connection instance
   *
   * @param {Socket} socket The socket this connection wraps
   * @param {Object} [options] Optional settings
   * @param {string} [options.host] The host the socket is connected to
   * @param {number} [options.port] The port used for the socket connection
   * @param {boolean} [options.keepAlive=true] TCP Connection keep alive enabled
   * @param {number} [options.keepAliveInitialDelay=300000] Initial delay before TCP keep alive enabled
   * @param {number} [options.connectionTimeout=30000] TCP Connection timeout setting
   * @param {number} [options.socketTimeout=360000] TCP Socket timeout setting
   * @param {boolean} [options.promoteLongs] Convert Long values from the db into Numbers if they fit into 53 bits
   * @param {boolean} [options.promoteValues] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
   * @param {boolean} [options.promoteBuffers] Promotes Binary BSON values to native Node Buffers.
   */
  constructor(
    public socket: Socket,
    public options: SocketOptions
  ) {
    super();

    options = options || {};
    if (!options.bson) {
      throw new TypeError('must pass in valid bson parser');
    }

    this.id = _id++;
    this.options = options;
    this.logger = Logger('Connection', options);
    this.bson = options.bson;
    this.tag = options.tag;
    this.maxBsonMessageSize = options.maxBsonMessageSize || DEFAULT_MAX_BSON_MESSAGE_SIZE;

    this.port = options.port || 27017;
    this.host = options.host || 'localhost';
    this.socketTimeout = typeof options.socketTimeout === 'number' ? options.socketTimeout : 360000;

    // These values are inspected directly in tests, but maybe not necessary to keep around
    this.keepAlive = typeof options.keepAlive === 'boolean' ? options.keepAlive : true;
    this.keepAliveInitialDelay =
      typeof options.keepAliveInitialDelay === 'number' ? options.keepAliveInitialDelay : 300000;
    this.connectionTimeout =
      typeof options.connectionTimeout === 'number' ? options.connectionTimeout : 30000;
    if (this.keepAliveInitialDelay > this.socketTimeout) {
      this.keepAliveInitialDelay = Math.round(this.socketTimeout / 2);
    }

    // Debug information
    if (this.logger.isDebug()) {
      this.logger.debug(
        `creating connection ${this.id} with options [${JSON.stringify(
          debugOptions(DEBUG_FIELDS as any, options) // TS-TODO
        )}]`
      );
    }

    // Response options
    this.responseOptions = {
      promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
      promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
      promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false
    };

    // Flushing
    this.flushing = false;
    this.queue = [];

    // Internal state
    this.writeStream = null;
    this.destroyed = false;

    // Create hash method
    const hash = createHash('sha1');
    hash.update(this.address);
    this.hashedName = hash.digest('hex');

    // All operations in flight on the connection
    this.workItems = [];

    // setup socket
    this.socket.once('error', errorHandler(this));
    this.socket.once('timeout', timeoutHandler(this));
    this.socket.once('close', closeHandler(this));
    this.socket.on('data', dataHandler(this));

    if (connectionAccounting) {
      addConnection(this.id, this);
    }
  }

  setSocketTimeout(value: number) {
    if (this.socket) {
      this.socket.setTimeout(value);
    }
  }

  resetSocketTimeout() {
    if (this.socket) {
      this.socket.setTimeout(this.socketTimeout);
    }
  }

  static enableConnectionAccounting(spy: any) {
    if (spy) {
      connectionAccountingSpy = spy;
    }

    connectionAccounting = true;
    connections = {};
  }

  static disableConnectionAccounting() {
    connectionAccounting = false;
    connectionAccountingSpy = undefined;
  }

  static connections() {
    return connections;
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  /**
   * Unref this connection
   * @method
   * @return {boolean}
   */
  unref() {
    if (this.socket == null) {
      this.once('connect', () => this.socket.unref());
      return;
    }

    this.socket.unref();
  }

  /**
   * Destroy connection
   * @method
   */
  destroy(options: { force?: boolean }, callback: DestroyCallback) : void;
  destroy(callback: DestroyCallback) : void;
  destroy() : void;
  destroy(options?: { force?: boolean }|DestroyCallback, callback?: DestroyCallback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    options = Object.assign({ force: false }, options);

    if (connectionAccounting) {
      deleteConnection(this.id);
    }

    if (this.socket == null) {
      this.destroyed = true;
      return;
    }

    if (options.force) {
      this.socket.destroy();
      this.destroyed = true;
      if (typeof callback === 'function') callback(null, null);
      return;
    }

    // TS-TODO
    this.socket.end(((err: any) => {
      this.destroyed = true;
      if (typeof callback === 'function') callback(err, null);
    }) as () => void);
  }

  /**
   * Write to connection
   * @method
   * @param {Command} command Command to write out need to implement toBin and toBinUnified
   */
  write(buffer: Buffer|Buffer[]) {
    // Debug Log
    if (this.logger.isDebug()) {
      if (!Array.isArray(buffer)) {
        this.logger.debug(`writing buffer [${buffer.toString('hex')}] to ${this.address}`);
      } else {
        for (let i = 0; i < buffer.length; i++)
          this.logger.debug(`writing buffer [${buffer[i].toString('hex')}] to ${this.address}`);
      }
    }

    // Double check that the connection is not destroyed
    if (this.socket.destroyed === false) {
      // Write out the command
      if (!Array.isArray(buffer)) {
        this.socket.write(buffer, 'binary');
        return true;
      }

      // Iterate over all buffers and write them in order to the socket
      for (let i = 0; i < buffer.length; i++) {
        this.socket.write(buffer[i], 'binary');
      }

      return true;
    }

    // Connection is destroyed return write failed
    return false;
  }

  /**
   * Return id of connection as a string
   * @method
   * @return {string}
   */
  toString() {
    return '' + this.id;
  }

  /**
   * Return json object of connection
   * @method
   * @return {object}
   */
  toJSON() {
    return { id: this.id, host: this.host, port: this.port };
  }

  /**
   * Is the connection connected
   * @method
   * @return {boolean}
   */
  isConnected() {
    if (this.destroyed) return false;
    return !this.socket.destroyed && this.socket.writable;
  }
}

function deleteConnection(id: number) {
  // console.log("=== deleted connection " + id + " :: " + (connections[id] ? connections[id].port : ''))
  delete connections[id];

  if (connectionAccountingSpy) {
    connectionAccountingSpy.deleteConnection(id);
  }
}

function addConnection(id: number, connection: Connection) {
  // console.log("=== added connection " + id + " :: " + connection.port)
  connections[id] = connection;

  if (connectionAccountingSpy) {
    connectionAccountingSpy.addConnection(id, connection);
  }
}

//
// Connection handlers
function errorHandler(conn: Connection) {
  return function(err: Error) {
    if (connectionAccounting) deleteConnection(conn.id);
    // Debug information
    if (conn.logger.isDebug()) {
      conn.logger.debug(
        `connection ${conn.id} for [${conn.address}] errored out with [${JSON.stringify(err)}]`
      );
    }

    conn.emit('error', new MongoNetworkError(err), conn);
  };
}

function timeoutHandler(conn: Connection) {
  return function() {
    if (connectionAccounting) deleteConnection(conn.id);

    if (conn.logger.isDebug()) {
      conn.logger.debug(`connection ${conn.id} for [${conn.address}] timed out`);
    }

    conn.emit(
      'timeout',
      new MongoNetworkError(`connection ${conn.id} to ${conn.address} timed out`),
      conn
    );
  };
}

function closeHandler(conn: Connection) {
  return function(hadError: boolean) {
    if (connectionAccounting) deleteConnection(conn.id);

    if (conn.logger.isDebug()) {
      conn.logger.debug(`connection ${conn.id} with for [${conn.address}] closed`);
    }

    if (!hadError) {
      conn.emit(
        'close',
        new MongoNetworkError(`connection ${conn.id} to ${conn.address} closed`),
        conn
      );
    }
  };
}

// Handle a message once it is received
function processMessage(conn: Connection, message: Buffer) {
  const msgHeader = parseHeader(message);
  if (msgHeader.opCode !== OP_COMPRESSED) {
    const ResponseConstructor = msgHeader.opCode === OP_MSG ? BinMsg : Response;
    conn.emit(
      'message',
      new ResponseConstructor(
        conn.bson,
        message,
        msgHeader,
        message.slice(MESSAGE_HEADER_SIZE),
        conn.responseOptions
      ),
      conn
    );

    return;
  }

  msgHeader.fromCompressed = true;
  let index = MESSAGE_HEADER_SIZE;
  msgHeader.opCode = message.readInt32LE(index);
  index += 4;
  msgHeader.length = message.readInt32LE(index);
  index += 4;
  const compressorID = message[index];
  index++;

  // TS-TODO
  decompress(compressorID, message.slice(index), (err: Error, decompressedMsgBody: Buffer) => {
    if (err) {
      conn.emit('error', err);
      return;
    }

    if (decompressedMsgBody.length !== msgHeader.length) {
      conn.emit(
        'error',
        new MongoError(
          'Decompressing a compressed message from the server failed. The message is corrupt.'
        )
      );

      return;
    }

    const ResponseConstructor = msgHeader.opCode === OP_MSG ? BinMsg : Response;
    conn.emit(
      'message',
      new ResponseConstructor(
        conn.bson,
        message,
        msgHeader,
        decompressedMsgBody,
        conn.responseOptions
      ),
      conn
    );
  });
}

// TS-TODO
function dataHandler(conn: Connection) {
  return function(data: Buffer) {
    // Parse until we are done with the data
    while (data.length > 0) {
      // If we still have bytes to read on the current message
      if (conn.bytesRead > 0 && conn.sizeOfMessage > 0) {
        // Calculate the amount of remaining bytes
        const remainingBytesToRead = conn.sizeOfMessage - conn.bytesRead;
        // Check if the current chunk contains the rest of the message
        if (remainingBytesToRead > data.length) {
          // Copy the new data into the exiting buffer (should have been allocated when we know the message size)
          data.copy((conn.buffer as Buffer), conn.bytesRead);
          // Adjust the number of bytes read so it point to the correct index in the buffer
          conn.bytesRead = conn.bytesRead + data.length;

          // Reset state of buffer
          data = SafeBuffer.alloc(0) as unknown as Buffer;
        } else {
          // Copy the missing part of the data into our current buffer
          data.copy((conn.buffer as Buffer), conn.bytesRead, 0, remainingBytesToRead);
          // Slice the overflow into a new buffer that we will then re-parse
          data = data.slice(remainingBytesToRead);

          // Emit current complete message
          const emitBuffer = conn.buffer as Buffer;
          // Reset state of buffer
          conn.buffer = null;
          conn.sizeOfMessage = 0;
          conn.bytesRead = 0;
          conn.stubBuffer = null;

          processMessage(conn, emitBuffer);
        }
      } else {
        // Stub buffer is kept in case we don't get enough bytes to determine the
        // size of the message (< 4 bytes)
        if (conn.stubBuffer != null && conn.stubBuffer.length > 0) {
          // If we have enough bytes to determine the message size let's do it
          if (conn.stubBuffer.length + data.length > 4) {
            // Prepad the data
            const newData = SafeBuffer.alloc(conn.stubBuffer.length + data.length) as unknown as Buffer;
            conn.stubBuffer.copy(newData, 0);
            data.copy(newData, conn.stubBuffer.length);
            // Reassign for parsing
            data = newData;

            // Reset state of buffer
            conn.buffer = null;
            conn.sizeOfMessage = 0;
            conn.bytesRead = 0;
            conn.stubBuffer = null;
          } else {
            // Add the the bytes to the stub buffer
            const newStubBuffer = SafeBuffer.alloc(conn.stubBuffer.length + data.length) as unknown as Buffer;
            // Copy existing stub buffer
            conn.stubBuffer.copy(newStubBuffer, 0);
            // Copy missing part of the data
            data.copy(newStubBuffer, conn.stubBuffer.length);
            // Exit parsing loop
            data = SafeBuffer.alloc(0) as unknown as Buffer;
          }
        } else {
          if (data.length > 4) {
            // Retrieve the message size
            const sizeOfMessage = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            // If we have a negative sizeOfMessage emit error and return
            if (sizeOfMessage < 0 || sizeOfMessage > conn.maxBsonMessageSize) {
              const errorObject = {
                err: 'socketHandler',
                trace: '',
                bin: conn.buffer,
                parseState: {
                  sizeOfMessage: sizeOfMessage,
                  bytesRead: conn.bytesRead,
                  stubBuffer: conn.stubBuffer
                }
              };
              // We got a parse Error fire it off then keep going
              conn.emit('parseError', errorObject, conn);
              return;
            }

            // Ensure that the size of message is larger than 0 and less than the max allowed
            if (
              sizeOfMessage > 4 &&
              sizeOfMessage < conn.maxBsonMessageSize &&
              sizeOfMessage > data.length
            ) {
              conn.buffer = SafeBuffer.alloc(sizeOfMessage) as unknown as Buffer;
              // Copy all the data into the buffer
              data.copy(conn.buffer, 0);
              // Update bytes read
              conn.bytesRead = data.length;
              // Update sizeOfMessage
              conn.sizeOfMessage = sizeOfMessage;
              // Ensure stub buffer is null
              conn.stubBuffer = null;
              // Exit parsing loop
              data = SafeBuffer.alloc(0) as unknown as Buffer;
            } else if (
              sizeOfMessage > 4 &&
              sizeOfMessage < conn.maxBsonMessageSize &&
              sizeOfMessage === data.length
            ) {
              const emitBuffer = data;
              // Reset state of buffer
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Exit parsing loop
              data = SafeBuffer.alloc(0) as unknown as Buffer;
              // Emit the message
              processMessage(conn, emitBuffer);
            } else if (sizeOfMessage <= 4 || sizeOfMessage > conn.maxBsonMessageSize) {
              const errorObject = {
                err: 'socketHandler',
                trace: null,
                bin: data,
                parseState: {
                  sizeOfMessage: sizeOfMessage,
                  bytesRead: 0,
                  buffer: null,
                  stubBuffer: null
                }
              };
              // We got a parse Error fire it off then keep going
              conn.emit('parseError', errorObject, conn);

              // Clear out the state of the parser
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Exit parsing loop
              data = SafeBuffer.alloc(0) as unknown as Buffer;
            } else {
              const emitBuffer = data.slice(0, sizeOfMessage);
              // Reset state of buffer
              conn.buffer = null;
              conn.sizeOfMessage = 0;
              conn.bytesRead = 0;
              conn.stubBuffer = null;
              // Copy rest of message
              data = data.slice(sizeOfMessage);
              // Emit the message
              processMessage(conn, emitBuffer);
            }
          } else {
            // Create a buffer that contains the space for the non-complete message
            conn.stubBuffer = SafeBuffer.alloc(data.length) as unknown as Buffer;
            // Copy the data to the stub buffer
            data.copy(conn.stubBuffer, 0);
            // Exit parsing loop
            data = SafeBuffer.alloc(0) as unknown as Buffer;
          }
        }
      }
    }
  };
}

/**
 * A server connect event, used to verify that the connection is up and running
 *
 * @event Connection#connect
 * @type {Connection}
 */

/**
 * The server connection closed, all pool connections closed
 *
 * @event Connection#close
 * @type {Connection}
 */

/**
 * The server connection caused an error, all pool connections closed
 *
 * @event Connection#error
 * @type {Connection}
 */

/**
 * The server connection timed out, all pool connections closed
 *
 * @event Connection#timeout
 * @type {Connection}
 */

/**
 * The driver experienced an invalid message, all pool connections closed
 *
 * @event Connection#parseError
 * @type {Connection}
 */

/**
 * An event emitted each time the connection receives a parsed message from the wire
 *
 * @event Connection#message
 * @type {Connection}
 */

module.exports = Connection;
