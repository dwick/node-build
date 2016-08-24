#!/usr/bin/env node
var _ = require('lodash');
var fs = require('fs');
var glob = require('glob');
var path = require('path');
var Mocha = require('mocha');
var colors = require('colors');
var rimraf = require('rimraf');
var mochaNotifier = require('mocha-notifier-reporter');

var build = require('../lib/build');
var makeBuild = require('../lib/makeBuild').makeBuild;
var configs = require('../lib/configs');
var getWebpackEntryForTest = require('../lib/getWebpackEntryForTest');

var TEST_DIR = './.test';
var PRODUCTION_ENV = 'production';
var TARGETS = {
  TEST: 'test',
  CLIENT: 'client',
  SERVER: 'server',
};

var argv = require('yargs')
  .alias('b', 'blueprintsPath')
    .describe('b', 'path to a raw-config via a node file with moduel.exports = config')
    .default('b', './blueprints.config.js')
  .alias('w', 'watch')
    .describe('w', '[DEFAULT=false] force watching of all builds')
    .default('w', false)
  .alias('i', 'ignoreBlueprints')
    .describe('ignore the blueprints.config.js file in the current directory and use defaults')
    .default('i', false)
  .alias('e', 'env')
    .describe('the environment to build for <production | dev>')
    .default('e', 'dev')
  .alias('t', 'target')
    .describe('the target to build')
    .default('t', null)
  .argv;

function loadBlueprintsFromPath(options) {
  try {
    console.log('...loading blueprints from', options.blueprintsPath)
    var builds = require(path.resolve(options.blueprintsPath));

    // build configuration files are written in js and can be:
    //   a) a function that takes isProduction (boolean) and returns an array of builds
    //   b) object with property named extensions, to extend / override default builds
    //   c) an array of builds
    // The array is most straightforward and the function seems infinitely
    // more useful than the extensions object, and easier to understand. I'd
    // like to deprecate the extensions object if its not being used in many places.
    if (typeof builds === 'function') {
      builds = builds(options);
    } else if (!Array.isArray(builds)) {
      if (builds.extensions === true) {
        return { extensions: _.omit(builds, 'extensions') };
      }
      builds = [builds];
    }

    return { builds };
  } catch (e) {
    console.log(colors.red('Error in loading blueprints'), e);
    process.exit(1);
  }
}

function loadDefaultConfigs(options) {
  console.log('...using default configs');
  var isProduction = options.env === PRODUCTION_ENV;
  switch (options.target) {
    case TARGETS.TEST:
      console.log('...Setting up tests:');
      var config = _.merge(
        {},
        configs.DefaultTestingConfig,
        { webpack: { entry: getWebpackEntryForTest('./') } }
      );

      return [ config ];
    case TARGETS.CLIENT:
      console.log('...client');
      return [ configs.getClientConfig(isProduction) ];
    case TARGETS.SERVER:
      console.log('...server');
      return [ configs.getServerConfig(isProduction) ];
    default:
      console.log('...both');
      return [
        configs.getClientConfig(isProduction),
        configs.getServerConfig(isProduction),
      ];

  }
}

function makeConfig(options) {
  var builds;
  var extensions = {};

  if (options.blueprintsPath && !options.ignoreBlueprints) {
    var blueprints = loadBlueprintsFromPath(options);

    if (blueprints.extensions) {
      extensions = blueprints.extensions;

    } else if (blueprints.builds && blueprints.builds.length) {
      builds = blueprints.builds;
    }
  }

  if (!builds) {
    builds = loadDefaultConfigs(options);
  }

  if (options.watch) {
    extensions.watch = true;
  }

  return {
    builds: builds.map(function(build) {
      return makeBuild(_.merge(build, extensions));
    }),
  };
};


console.log('...Reading Blueprints', argv.blueprintsPath);
console.log('...cwd', process.cwd());

var config = makeConfig(argv);
var isTest = argv.target === TARGETS.TEST;

build(config, function(stats) {
  if (stats.errors && stats.errors.length > 0 && !argv.watch) {
    console.log(colors.red('ERROR IN BUILD. Aborting.'));
    process.exit(1);
  }

  if (isTest) {
    console.log(colors.magenta(
      '\n   ******************************' +
      '\n   *       RUNNING TESTS        *' +
      '\n   ******************************'
    ));

    m = new Mocha({ reporter: mochaNotifier.decorate('spec') });
    glob(path.join(TEST_DIR, '/**/*.compiledtest'), function (err, files) {
      files.forEach(function(asset) {
        m.addFile(asset);
      });
      m.run();

      // we want to remove these from the require cache while we have path
      // references to them to ensure they get tested on the next rebuild
      m.files.forEach(function(filePath) {
        delete require.cache[require.resolve(path.resolve(filePath))];
      });
    });

    // Hacky way to handle webpacks file output
    function cleanup(err) {
      if (err) {
        console.error(err.stack);
      }

      try {
        rimraf.sync(path.join(process.cwd(), TEST_DIR));
      } catch (e) {
        // pass
      }

      process.exit();
    }

    process.on('SIGINT', cleanup);
    process.on('exit', cleanup);
    process.on('uncaughtException', cleanup);
  }
});
