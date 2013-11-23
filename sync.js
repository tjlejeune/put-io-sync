var PutIO = require('put.io-v2');
var argv = require( 'argv' );
var _ = require('underscore');
var fs = require('fs');
var execSync = require('execSync');
var Pushover = require('node-pushover');
var request = require('request');
var TVShowMatcher = require('./tvshowdir');
var config = require('./config');
require('longjohn');

var push = null;
if (config.pushpin.enabled) {
  push = new Pushover({
    token: config.pushpin.appkey,
    user: config.pushpin.userkey
  });
} else {
  push = {
    send: function() {}
  };
}

var api = new PutIO(config.putIo.oauth2key);

var args = argv.option([{
  name: 'directory-id',
  short: 'd',
  type: 'int',
  description: 'id of the directory to sync'
}, {
  name: 'local-path',
  short: 'l',
  type: 'path',
  description: 'local dir to sync to'
}, {
  name: 'tvshow-dir',
  short: 's',
  type: 'path',
  description: '(optional) local filepath of your TV show dir'
}]).run();

var directoryId = args.options['directory-id'] || 0;
var localPath = args.options['local-path'];
var tvShowDir = args.options['tvshow-dir'];
var matcher = null;
if (tvShowDir) {
  matcher = TVShowMatcher(tvShowDir);
} else {
  matcher = function() {};
}

function checkLocalFile(localFilename, callback) {
  fs.stat(localFilename, function(err, stat) {
    fs.stat(localFilename + '.aria2', function(ariaErr, ariaStat) {
      var downloadIsInProgress = (ariaStat != null);
      var downloadIsCompleted = (!downloadIsInProgress && (stat != null));

      callback(downloadIsInProgress, downloadIsCompleted);
    });
  });
}

function deleteShowIfCompleted(api, fileNode, stat, localFilename, callback) {
  fs.stat(localFilename + '.aria2', function(err, aria2fileStat) {
    if (!err) {
      // an .aria2 file exists: we can't delete this yet
      callback(false);
    } else if (stat && stat.size == fileNode.size) {
      // this file was allready downloaded - so we might delete it
      console.log('deleting ' + fileNode.name + ' from put.io');
      api.files.delete(fileNode.id);
      callback(true);
    } else {
      callback(false);
    };
  });
}

function sendRPCRequest(methodName, params) {
  if (!params) params = [];

  request.post({
      url: 'http://' + config.aria2c.rpcHost + '/jsonrpc',
      json: {
        "jsonrpc":"2.0",
        "method":methodName,
        "params": params,
        "id":"1",
        "timeout": 5000
      }
    }, function(error, response, body) {
      if (error && error.code == 'ECONNREFUSED') {
        console.error('connection refused to aria2c rpc at ' + config.aria2c.rpcHost);
        console.error('could it be you forgot to start aria2c --enable-rpc ?');
      }

      if (body && body.error) {
        console.error('aria2c response: ' + body.error.message);
      }
    }
  );
}

function listDir(directoryId, localPath, isChildDir) {
  api.files.list(directoryId, function gotPutIoListing(data) {
    if (data.files.length == 0) {
      if (isChildDir) {
        console.log('deleting empty directory from put.io');
        api.files.delete(directoryId);
      }
    } else {
      fs.mkdir(localPath, 0766, function dirCreated() {
        _.each(data.files, function eachFile(fileNode) {
          var localFilePath = localPath + '/' + fileNode.name;

          if (fileNode.content_type == 'application/x-directory') {
            listDir(fileNode.id, localFilePath, true);
          } else {
            var fileDir = localPath;
            var tvshow = matcher(fileNode.name);

            if (tvshow) fileDir = tvshow.path;

            var finalPath = fileDir + '/' + fileNode.name;
            var downloadURL = api.files.download(fileNode.id);

            checkLocalFile(finalPath, function(downloadIsInProgress, downloadIsCompleted) {
              if (downloadIsCompleted) {
                console.log('should delete ' + JSON.stringify(fileNode.name));
//                api.files.delete(fileNode.id);
              } else if (downloadIsInProgress) {
                console.log('download in progress: ' + fileNode.name);
              } else {
                if (config.aria2c.rpcHost && config.aria2c.useRPC) {
                  console.log('adding ' + localFilePath + ' to the download queue...');
                  sendRPCRequest('aria2.addUri', [ [ downloadURL ], { dir: fileDir } ]);

                  if (tvshow) {
                    push.send('put.io sync', 'Began download of an episode of ' + tvshow.name);
                  } else {
                    push.send('put.io sync', 'Began download of ' + fileNode.name);
                  }

                } else {
//                  var shellCommand = config.aria2c.path + ' -d "' + fileDir + '" "' + downloadURL + '"';

                  console.log('downloading ' + localFilePath + '...');
                  console.log(shellCommand);
                  var result = execSync.stdout(shellCommand);

                  fs.stat(finalPath, function gotFinalStat(err, afterStat) {
                    deleteShowIfCompleted(api, fileNode, afterStat, finalPath);
                  });

                  if (fileNode.size > 20 * 1024 * 1024) {
                    if (tvshow) {
                      push.send('put.io sync', 'Downloaded an episode of ' + tvshow.name);
                    } else {
                      push.send('put.io sync', 'Downloaded ' + fileNode.name);
                    }
                  }
                }
              }
            });
          }
        });
      });
    }
  });
}

var lockFile = '/tmp/putiosync-' + directoryId + '.lock';

if (fs.existsSync(lockFile)) {
  console.log('Process already running. If it is not the delete ' + lockFile);
} else {
  process.on('exit', function() {
    fs.unlinkSync(lockFile);
  });
  fs.open(lockFile, 'w', 0666, function(err, fd) {
    fs.closeSync(fd);
  });
  listDir(directoryId, localPath, false);
}

