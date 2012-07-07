var path = require('path');
var fs = require('fs');
var cluster = require('cluster');
var jsp = require("uglify-js").parser;
var pro = require("uglify-js").uglify;
var uglifycss = require("uglifycss");

var basePath, onMaster, onWorker, files_cache = [], build = {}, workers = [], isWait = false, isWaitError = false;
;

var compileSync = function (res, id, type) {
    var output_data = '';

    for (var p in res.output) break; // Extract key/value
    var cacheName = id + '-' + res.time + '.' + type; // Generate combined file name
    res.url = res.output[p] + '/' + cacheName; // Cached version URL

    var output_file = path.join(basePath, p, cacheName); // Cache version local path

    fs.exists(output_file, function (exists) {
        if (!exists) {
            for (var i in res.input) {
                var input_file = path.join(basePath, res.input[i]);
                var orig_data = fs.readFileSync(input_file, 'ascii');

                // Minify and optimize input data
                if (type == 'js' && res.compress) {
                    var ast = jsp.parse(orig_data); // parse code and get the initial AST
                    ast = pro.ast_mangle(ast); // get a new AST with mangled names
                    ast = pro.ast_squeeze(ast); // get an AST with compression optimizations
                    output_data += pro.gen_code(ast) + ";\n"; // compressed code here
                } else if (type == 'css' && res.compress) {
                    output_data += uglifycss.processString(orig_data, { maxLineLen: 150 }) + "\n";
                } else {
                    output_data += orig_data + "\n";
                }
            }

            fs.writeFile(output_file, output_data, function (err) {
                if (err) {
                    throw new Error('[MANAGER]'.magenta + ' Cant write to output file: ' + output_file.red);
                }
            });
        }
    });
}

var checkSync = function (res, id, type, watch) {
    for (var i in res.input) {
        var input_file = path.join(basePath, res.input[i]);

        (function (input_file, i) {
            fs.stat(input_file, function (err, stat) {
                if (!err) {
                    var mtime = stat.mtime.getTime();

                    if (typeof res.time == 'undefined' || mtime > res.time) {
                        res.time = mtime;
                    }

                    // Attach file change monitor, if required
                    if (watch) {
                        var interval = parseInt(watch);
                        fs.watch(input_file, { persistent: true, interval: !isNaN(interval) ? interval : 2000 }, function (event, filename) {
                            if (event == 'change') {
                                if (typeof filename != 'undefined') {
                                    console.log('[MANAGER]'.magenta + ' Asset file changed: ' + filename.bold + 'Reloading...');
                                } else {
                                    console.log('[MANAGER]'.magenta + ' An file changed'.bold);
                                }

                                // Reprocess input files, observer attached, no need to attach it one more time
                                checkSync(res, id, type, false);
                            }
                        });
                    }

                    // Last file, check is cache version exist
                    if (i == res.input.length - 1) {
                        // Reprocess input files
                        compileSync(res, id, type);
                    }
                }
            });
        })(input_file, i);
    }
}

var sourceWatcher = function () {
    for (var file in require.cache) {
        if (files_cache.indexOf(file) == -1) {
            if (file.indexOf('node_modules') > -1) {
                continue;
            }

            files_cache.push(file);

            fs.watch(file, { persistent: true, interval: 500 }, function (event, filename) {
                isWaitError = false;

                if (!isWait) {
                    isWait = true;
                    manageWorkers();

                    console.log('[MANAGER]'.magenta + ' ' + (filename || 'File').bold + ' changed, reloading... ');

                    setTimeout(function () {
                        isWait = false;
                        manageWorkers();
                    }, 500)
                }
            });
        }
    }

    setTimeout(sourceWatcher, 2000);
}

var manageWorkers = function () {
    if (workers.length > 0) {
        workers.forEach(function (w) {
            w.send({ stop: true });
        });

        workers = [];
    } else {
        var workersCount = parseInt(build.workers) || 1;

        // Fork workers
        for (var i = 0; i < workersCount; i++) {
            workers.push(cluster.fork());
        }
    }
}

//Public methods
module.exports.on = function (event, cb) {
    if (event == 'master') {
        onMaster = cb;
    } else if (event == 'worker') {
        onWorker = cb;
    }
}

// Generate URL for asset cached version
module.exports.css = function (id) {
    if (typeof build.css[id] == 'undefined') {
        return '<strong>ERROR: Specified style resource "' + id + '" doesn\'t registered in build.json</strong>';
    }

    return '<link href="' + build.css[id].url + '" rel="stylesheet"/>';
}

module.exports.js = function (id) {
    if (typeof build.js[id] == 'undefined') {
        return '<strong>ERROR: Specified javascript resource "' + id + '" doesn\'t registered in build.json</strong>';
    }

    return '<script src="' + build.js[id].url + '" type="text/javascript"></script>';
}

module.exports.start = function (config) {
    (function () {
        var colors = {
            'bold': ['\033[1m', '\033[22m'],
            'italic': ['\033[3m', '\033[23m'],
            'underline': ['\033[4m', '\033[24m'],
            'inverse': ['\033[7m', '\033[27m'],

            'white': ['\033[37m', '\033[39m'],
            'grey': ['\033[90m', '\033[39m'],
            'black': ['\033[30m', '\033[39m'],

            'blue': ['\033[34m', '\033[39m'],
            'cyan': ['\033[36m', '\033[39m'],
            'green': ['\033[32m', '\033[39m'],
            'magenta': ['\033[35m', '\033[39m'],
            'red': ['\033[31m', '\033[39m'],
            'yellow': ['\033[33m', '\033[39m']
        };

        for (var val in colors) {
            (function (c) {
                String.prototype.__defineGetter__(c, function () {
                    return colors[c][0] + this + colors[c][1];
                });
            })(val);
        }

        String.prototype.__defineGetter__('print', function () {
            console.log(this);
        })
    })();

    if (typeof config != 'object') {
        config = {};
    }

    basePath = config.basePath || path.dirname(require.main.filename);
    build = require(path.join(basePath, 'build.json'));

    for (var val in config) {
        build[val] = config[val];
    }

    if (typeof build != 'object') {
        throw new Error('[MANAGER]'.magenta + ' Cant load configuration from build.json'.red);
    }
    // Monitor JS files changes
    if (typeof build.js == 'object') {
        for (var id in build.js) {
            (function (id, res) {
                if (typeof res.input == 'string') {
                    res.input = [res.input];
                }

                checkSync(res, id, 'js', res.watch);
            })(id, build.js[id]);
        }
    }

    // Monitor CSS files changes
    if (typeof build.css == 'object') {
        for (var id in build.css) {
            (function (id, res) {
                if (typeof res.input == 'string') {
                    res.input = [res.input];
                }

                checkSync(res, id, 'css', res.watch);
            })(id, build.css[id]);
        }
    }

    if (cluster.isMaster) {
        manageWorkers();

        cluster.on('death', function (worker) {
            if (worker.exitCode != 0) {
                if (worker.exitCode != 101 && !isWaitError) {
                    isWaitError = true;
                    cluster.fork();
                }
            } else {
                console.log('[MANAGER]'.magenta + ' Worker [' + worker.pid + '] exited with code 0');
            }
        });

        if (typeof onMaster == 'function') {
            onMaster();
        }

        sourceWatcher();
    } else {
        process.on('message', function (msg) {
            if (msg.stop) {
                process.exit(101);
            }
        });

        if (typeof onWorker == 'function') {
            onWorker(process.env.NODE_WORKER_ID || 0); // Call with current worker number
        }
    }

    return this;
}