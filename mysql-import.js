/**
 * mysql-import - v4.1.11
 * Import .sql into a MySQL database with Node.
 * @author Rob Parham
 * @website https://github.com/pamblam/mysql-import#readme
 * @license MIT
 */

'use strict';

const mysql = require('mysql');
const fs = require('fs');
const path = require("path");


/**
 * mysql-import - Importer class
 * @version 4.1.11
 * https://github.com/Pamblam/mysql-import
 */

class Importer{
	
	/**
	 * new Importer(settings)
	 * @param {host, user, password[, database]} settings - login credentials
	 */
	constructor(settings){
		this._connection_settings = settings;
		this._conn = null;
		this._encoding = 'utf8';
		this._imported = [];
	}
	
	/**
	 * Get an array of the imported files
	 * @returns {Array}
	 */
	getImported(){
		return this._imported.slice(0);
	}
	
	/**
	 * Set the encoding to be used for reading the dump files.
	 * @param string - encoding type to be used.
	 * @throws {Error} - if unsupported encoding type. 
	 * @returns {undefined}
	 */
	setEncoding(encoding){
		var supported_encodings = [
			'utf8',
			'ucs2',
			'utf16le',
			'latin1',
			'ascii',
			'base64',
			'hex'
		];
		if(!supported_encodings.includes(encoding)){
			throw new Error("Unsupported encoding: "+encoding);
		}
		this._encoding = encoding;
	}
	
	/**
	 * Set or change the database to be used
	 * @param string - database name
	 * @returns {Promise}
	 */
	use(database){
		return new Promise((resolve, reject)=>{
			if(!this._conn){
				this._connection_settings.database = database;
				return;
			}
			this._conn.changeUser({database}, err=>{
				if (err){
					reject(err);	
				}else{
					resolve();
				}
			});
		});
	}
	
	/**
	 * Import (an) .sql file(s).
	 * @param string|array input - files or paths to scan for .sql files
	 * @returns {Promise}
	 */
	import(...input){
		return new Promise(async (resolve, reject)=>{
			try{
				await this._connect();
				var files = await this._getSQLFilePaths(...input);
				var error = null;
				await slowLoop(files, (file, index, next)=>{
					if(error){
						next();
						return;
					}
					this._importSingleFile(file).then(()=>{
						next();
					}).catch(err=>{
						error = err;
						next();
					});
				});
				if(error) throw error;
				await this.disconnect();
				resolve();
			}catch(err){
				reject(err);
			}
		});
	};
	
	/**
	 * Disconnect mysql. This is done automatically, so shouldn't need to be manually called.
	 * @param bool graceful - force close?
	 * @returns {Promise}
	 */
	disconnect(graceful=true){
		return new Promise((resolve, reject)=>{
			if(!this._conn){
				resolve();
				return;
			}
			if(graceful){
				this._conn.end(err=>{
					if(err){
						reject(err);
						return;
					}
					this._conn = null;
					resolve();
				});
			}else{
				this._conn.destroy();
				resolve();
			}				
		});
	}
	
	////////////////////////////////////////////////////////////////////////////
	// Private methods /////////////////////////////////////////////////////////
	////////////////////////////////////////////////////////////////////////////
	
	/**
	 * Import a single .sql file into the database
	 * @param {type} filepath
	 * @returns {Promise}
	 */
	_importSingleFile(filepath){
		return new Promise((resolve, reject)=>{
			var error = null;
			var parser = new queryParser();
			parser.onQuery(query=>{
				this._conn.query(query, err=>{
					if (err) error = err;
				});
			});
			var readerStream = fs.createReadStream(filepath);
			readerStream.setEncoding(this._encoding);
			readerStream.on('data', chunk=>parser.onStream(chunk));
			readerStream.on('end', ()=>{
				parser.onQueueFinished(()=>{
					this._imported.push(filepath);
					resolve();
				});
			});
			readerStream.on('error', err=>reject(err));
		});
	}
	
	/**
	 * Import a single .sql file into the database
	 * @param {type} filepath
	 * @returns {Promise}
	 */
	_importSingleFile_nostream(filepath){
		return new Promise((resolve, reject)=>{
			fs.readFile(filepath, this._encoding, (err, queriesString) => {
				if(err){
					reject(err);
					return;
				}
				var queries = new queryParser(queriesString).queries;
				var error = null;
				slowLoop(queries, (query, index, next)=>{
					if(error){
						next();
						return;
					}
					this._conn.query(query, err=>{
						if (err) error = err;
						next();
					});
				}).then(()=>{
					if(error){
						reject(error);
					}else{
						this._imported.push(filepath);
						resolve();
					}
				});
				
			});
		});
	}
	
	/**
	 * Connect to the mysql server
	 * @returns {Promise}
	 */
	_connect(){
		return new Promise((resolve, reject)=>{
			if(this._conn){
				resolve(this._conn);
				return;
			}
			var connection = mysql.createConnection(this._connection_settings);
			connection.connect(err=>{
				if (err){
					reject(err);	
				}else{
					this._conn = connection;
					resolve();
				}
			});
		});
	}
	
	/**
	 * Check if a file exists
	 * @param string filepath
	 * @returns {Promise}
	 */
	_fileExists(filepath){
		return new Promise((resolve, reject)=>{
			fs.access(filepath, fs.F_OK, err=>{
				if(err){
					reject(err);
				}else{
					resolve();
				}
			});
		});
	}

	/**
	 * Get filetype information
	 * @param string filepath
	 * @returns {Promise}
	 */
	_statFile(filepath){
		return new Promise((resolve, reject)=>{
			fs.lstat(filepath, (err, stat)=>{
				if(err){
					reject(err);
				}else{
					resolve(stat);
				}
			});
		});
	}
	
	/**
	 * Read contents of a directory
	 * @param string filepath
	 * @returns {Promise}
	 */
	_readDir(filepath){
		return new Promise((resolve, reject)=>{
			fs.readdir(filepath, (err, files)=>{
				if(err){
					reject(err);
				}else{
					resolve(files);
				}
			});
		});
	}

	/**
	 * Parses the input argument(s) for Importer.import into an array sql files.
	 * @param strings|array paths
	 * @returns {Promise}
	 */
	_getSQLFilePaths(...paths){
		return new Promise(async (resolve, reject)=>{
			var full_paths = [];
			var error = null;
			paths = [].concat.apply([], paths); // flatten array of paths
			await slowLoop(paths, async (filepath, index, next)=>{
				if(error){
					next();
					return;
				}
				try{
					await this._fileExists(filepath);
					var stat = await this._statFile(filepath);
					if(stat.isFile()){
						if(filepath.toLowerCase().substring(filepath.length-4) === '.sql'){
							full_paths.push(path.resolve(filepath));
						}
						next();
					}else if(stat.isDirectory()){
						var more_paths = await this._readDir(filepath);
						more_paths = more_paths.map(p=>path.join(filepath, p));
						var sql_files = await this._getSQLFilePaths(...more_paths);
						full_paths.push(...sql_files);
						next();
					}else{
						next();
					}
				}catch(err){
					error = err;
					next();
				}
			});
			if(error){
				reject(error);
			}else{
				resolve(full_paths);
			}
		});
	}
	
}

/**
 * Build version number
 */
Importer.version = '4.1.11';

module.exports = Importer;

/**
 * Execute the loopBody function once for each item in the items array, 
 * waiting for the done function (which is passed into the loopBody function)
 * to be called before proceeding to the next item in the array.
 * @param {Array} items - The array of items to iterate through
 * @param {Function} loopBody - A function to execute on each item in the array.
 *		This function is passed 3 arguments - 
 *			1. The item in the current iteration,
 *			2. The index of the item in the array,
 *			3. A function to be called when the iteration may continue.
 * @returns {Promise} - A promise that is resolved when all the items in the 
 *		in the array have been iterated through.
 */
function slowLoop(items, loopBody) {
	return new Promise(f => {
		if(!items.length) return f();
		let done = arguments[2] || f;
		let idx = arguments[3] || 0;
		let cb = items[idx + 1] ? () => slowLoop(items, loopBody, done, idx + 1) : done;
		loopBody(items[idx], idx, cb);
	});
}


class queryParser{
	
	constructor(queriesString){
		
		// query handler function
		this.queryHandler = ()=>{};
		
		// completion handler
		this.completeHandler = ()=>{};
		
		// chunks of data that need to be processed
		this.pending_chunks = [];
		
		// is currently parsing?
		this.parsing = false;
		
		// The quote type (' or ") if the parser 
		// is currently inside of a quote, else false
		this.quoteType = false;
		
		// An array of chars representing the substring
		// the is currently being parsed
		this.buffer = [];
		
		// Is the current char escaped
		this.escaped = false;
		
		// The string that denotes the end of a query
		this.delimiter = ';';
		
		// Are we currently seeking new delimiter
		this.seekingDelimiter = false;
	}
	
	// set a callback function to be called when the current queue is finished
	// or immediately if there is no current queue
	onQueueFinished(fn){
		if(typeof fn !== 'function') return false;
		this.completeHandler = fn;
		if(!this.parsing) this.completeHandler();
	}
	
	// handle a portion of the data file from a read stream
	onStream(chunk){
		this.pending_chunks.push(chunk);
		this.handlePendingChunks();
	}
	
	// Add a function to do something with each query.
	// by running the callback and garbage collecting we can handle large files
	onQuery(fn){
		if(typeof fn !== 'function') return false;
		this.queryHandler = fn;
	}
	
	////////////////////////////////////////////////////////////////////////////
	// "Private" methods" //////////////////////////////////////////////////////
	////////////////////////////////////////////////////////////////////////////
	
	// recursively parse pending chunks of data
	handlePendingChunks(){
		if(this.parsing) return;
		this.parsing = true;
		var chunk = this.pending_chunks.shift();
		for (let i = 0; i < chunk.length; i++) {
			let char = chunk[i];
			this.parseChar(char);
		}
		this.parsing = false;
		if(this.pending_chunks.length) this.handlePendingChunks();
		else this.completeHandler();
	}
	
	// Parse the next char in the string
	parseChar(char){
		this.checkEscapeChar();
		this.buffer.push(char);

		this.checkNewDelimiter(char);

		this.checkQuote(char);
		this.checkEndOfQuery();
	}
	
	// Check if the current char has been escaped
	// and update this.escaped
	checkEscapeChar(){
		if(!this.buffer.length) return;
		if(this.buffer[this.buffer.length - 1] === "\\"){
			this.escaped = !this.escaped;
		}else{
			this.escaped = false;
		}
	}
	
	// Check to see if a new delimiter is being assigned
	checkNewDelimiter(char){
		var buffer_str = this.buffer.join('').toLowerCase().trim();
		if(buffer_str === 'delimiter' && !this.quoteType){
			this.seekingDelimiter = true;
			this.buffer = [];
		}else{
			var isNewLine = char === "\n" || char === "\r";
			if(isNewLine && this.seekingDelimiter){
				this.seekingDelimiter = false;
				this.delimiter = this.buffer.join('').trim();
				this.buffer = [];
			}
		}
	}
	
	// Check if the current char is a quote
	checkQuote(char){
		var isQuote = (char === '"' || char === "'") && !this.escaped;
		if (isQuote && this.quoteType === char){
			this.quoteType = false;
		}else if(isQuote && !this.quoteType){
			this.quoteType = char;
		}
	}
	
	// Check if we're at the end of the query
	checkEndOfQuery(){
		var demiliterFound = false;
		if(!this.quoteType && this.buffer.length >= this.delimiter.length){
			demiliterFound = this.buffer.slice(-this.delimiter.length).join('') === this.delimiter;
		}

		if (demiliterFound) {
			// trim the delimiter off the end
			this.buffer.splice(-this.delimiter.length, this.delimiter.length);
			this.queryHandler(this.buffer.join('').trim());
			this.buffer = [];
		}
	}
}
