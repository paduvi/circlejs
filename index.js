/**
 * Created by chotoxautinh on 12/27/16.
 */
var Promise = require('bluebird');
var fs = require('fs');
var path = require('path');
var glob = require('glob');
var http = require('http');
var express = require('express');
var cors = require('cors');
var stack = require('callsite');
var passport = require('passport');

class Application {
    constructor() {

        process.env.NODE_ENV = process.env.NODE_ENV || 'development';
        global.__base = path.dirname(stack()[1].getFileName());
        this.rootFolder = __base;

        var app = express();

        Object.assign(this, app);
        this.expressApp = function (req, res, next) {
            this.handle(req, res, next);
        }.bind(this);

        this.plugin = {}
        this.plug = function (plugin, ...args) {
            plugin.apply(this, args);
        }.bind(this);

        this.getGlobalConfig();
        this.getGlobalSetting();
        this.useLogger();
        this.useExpressSetting();
    }

    getGlobalConfig() {
        this.config = require(__base + "/config/config.js");
        try {
            fs.accessSync(`${__base}/config/env/config-${process.env.NODE_ENV}.js`, fs.F_OK);
            Object.assign(this.config, require(`${__base}/config/env/config-${process.env.NODE_ENV}.js`));
        } catch (e) {
            // It isn't accessible
        }
    }

    getGlobalSetting() {
        this.setting = require(__base + "/config/setting.js");
        try {
            fs.accessSync(`${__base}/config/env/setting-${process.env.NODE_ENV}.js`, fs.F_OK);
            Object.assign(this.setting, require(`${__base}/config/env/setting-${process.env.NODE_ENV}.js`));
        } catch (e) {
            // It isn't accessible
        }
    }

    useLogger() {
        let logger = require(`${__base}/config/logger.js`);
        this.logger = logger;
    }

    useExpressSetting() {
        let expressFunction = require(`${__base}/config/express.js`);
        expressFunction(this);
    }

    loadHelpers() {
        var self = this;
        let files = glob.sync(`${__base}/utilities/helpers/*.js`)
        let helpers = {};
        files.map(function (filePath) {
            let filename = path.basename(filePath, '.js');
            helpers[filename] = require(filePath);
        });
        return Object.assign(self, {helpers: helpers});
    }

    start() {
        var self = this;
        return Promise.resolve().then(function () {
            return self.loadHelpers();
        }).then(function () {
            return self.connectDatabase();
        }).then(function (db) {
            let dbList = Object.keys(db);
            if (dbList.length) {
                dbList.forEach(function (dbName) {
                    db[dbName].models = {}
                });
            } else {
                db.models = {}
            }
            self.db = db;
            return self.loadModels();
        }).then(function () {
            let database = require(`${__base}/config/database.js`);
            return database.afterInitialize(self);
        }).then(function () {
            return self.loadSeneca();
        }).then(function () {
            return self.loadPassport();
        }).then(function () {
            return self.loadWebController();
        }).then(function () {
            return self.handleError();
        }).then(function () {
            return http.createServer(self.expressApp);
        }).then(function (server) {
            self.httpServer = server;

            self.seneca.listen(self.setting.seneca);

            server.listen(self.setting.web.port, () => {
                self.logger.info('Application loaded using the "' + process.env.NODE_ENV + '" environment configuration');
                self.logger.info('Application started on port ' + self.setting.web.port, ', Process ID: ' + process.pid);
            });

            return;
        }).catch(function (err) {
            console.error(err)
        });
    }

    handleError() {
        var errorHandler = require(`${__base}/config/error.js`);
        errorHandler(this);
    }

    connectDatabase() {
        let database = require(`${__base}/config/database.js`);
        return database.beforeInitialize(this);
    }

    loadModels() {
        var self = this;
        let dbList = Object.keys(this.db);
        if (dbList.length) {
            let files = glob.sync(`${__base}/model/+(${dbList.join("|")})/*.js`);
            return Promise.map(files, function (filePath) {
                let dbName = path.dirname(filePath).split("/").pop();
                let modelName = path.basename(filePath, '.js');
                let content = require(filePath)(self.db[dbName]);
                self.db[dbName].models[modelName] = content;
                return;
            });
        }
    }

    loadPassport() {
        var self = this;
        if (self.setting.web.passport) {
            self.use(passport.initialize());
            let files = glob.sync(`${__base}/config/passport/*.js`);
            return Promise.map(files, function (filePath) {
                const strategyName = path.basename(filePath, '.js');
                passport.use(strategyName, require(filePath));
                return;
            });
        }
    }

    loadWebController() {
        var self = this;
        const folder_name = self.setting.web.path || 'web';
        let files = glob.sync(`${__base}/controller/${folder_name}/*/route.js`);
        return Promise.map(files, function (filePath) {
            let controllerName = path.dirname(filePath).split("/").pop();
            let content = require(filePath)(self);
            return Promise.map(Object.keys(content), function (route) {
                if (!route.startsWith("/"))
                    route = "/" + route;
                let prefix = self.setting.web.prefix || '';
                return self.loadWebRoute(prefix + "/" + controllerName + route, content[route]);
            })
        });
    }

    loadWebRoute(route, methods) {
        var self = this;
        return Promise.map(Object.keys(methods), function (method) {
            const handlers = methods[method];
            let middleware = handlers.middleware || [];
            const handler = handlers.handler;

            const authProp = handlers.authenticate;
            if (authProp && self.setting.web.passport) {
                middleware.unshift(passport.authenticate(authProp.name, Object.assign({}, authProp.options, {session: false})));
                if (authProp.permissions) {
                    middleware.splice(1, 0, function (req, res, next) {
                        if (authProp.permissions.some((v) => req.user.permissions.indexOf(v) >= 0))
                            return next();
                        next('Do not have permissions');
                    })
                }
            }

            const corsProp = handlers.cors;
            if (corsProp && process.env.NODE_ENV != 'development') {
                var corsOptions = {
                    origin: corsProp,
                    optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
                };
                middleware.unshift(cors(corsOptions));
            }
            self[method](route, ...middleware, handler);
            return;
        })
    }

    loadSeneca() {
        var self = this;
        self.seneca = require('seneca')({strict: false});
        self.seneca.exec = Promise.promisify(self.seneca.act);
        let files = glob.sync(`${__base}/action/*.js`);
        return Promise.map(files, function (filePath) {
            let roleName = path.basename(filePath, '.js');
            let content = require(filePath)(self);
            Object.keys(content).forEach(function (key) {
                self.addSenecaCommand(roleName, key, content[key]);
            });
            return;
        });
    }

    addSenecaCommand(role, cmd, func) {
        this.seneca.use(function () {
            this.add({role: role, cmd: cmd}, func);
        });
    }
}

module.exports = Application;