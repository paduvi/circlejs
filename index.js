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

        this.getGlobalSetting();
        this.getGlobalConfig();
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
        const logger = require(`${__base}/config/logger.js`);
        this.logger = logger;
    }

    useExpressSetting() {
        require(`${__base}/config/express.js`)(this);
    }

    loadHelpers() {
        var self = this;
        const files = glob.sync(`${__base}/utilities/helpers/*.js`)
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
            return self.loadServices();
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
        require(`${__base}/config/error.js`)(this);
    }

    connectDatabase() {
        const database = require(`${__base}/config/database.js`);
        return database.beforeInitialize(this);
    }

    loadModels() {
        var self = this;
        const dbList = Object.keys(this.db);
        if (dbList.length) {
            let files = glob.sync(`${__base}/model/+(${dbList.join("|")})/*.js`);
            return Promise.map(files, function (filePath) {
                const dbName = path.dirname(filePath).split("/").pop();
                const modelName = path.basename(filePath, '.js');
                return Promise.resolve(require(filePath)(self.db[dbName])).then(model => {
                    self.db[dbName].models[modelName] = model;
                })
            });
        }
    }

    loadServices() {
        var self = this;
        self.services = {}
        let files = glob.sync(`${__base}/service/*.js`);
        return Promise.map(files, function (filePath) {
            return Promise.resolve(require(filePath)(self)).then(service => {
                const serviceName = path.basename(filePath, '.js');
                self.services[serviceName] = service;
            })
        });
    }

    loadPassport() {
        var self = this;
        if (self.setting.web.passport) {
            self.use(passport.initialize());
            let files = glob.sync(`${__base}/config/passport/*.js`);
            return Promise.map(files, function (filePath) {
                const strategyName = path.basename(filePath, '.js');
                passport.use(strategyName, require(filePath)(self));
                return;
            });
        }
    }

    loadWebController() {
        var self = this;
        const folder_name = self.setting.web.path || 'web';
        const files = glob.sync(`${__base}/controller/${folder_name}/*/route.js`);
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
                middleware.unshift((req, res, next) => {
                    passport.authenticate(authProp.name, Object.assign({session: false}, authProp.options),
                        (err, user, info) => {
                            if (err) {
                                return next(err);
                            }

                            //authentication error
                            if (!user) {
                                return res.status(401).format({
                                    html: () => res.send(info.message || 'Unauthorized'),
                                    json: () => res.send({
                                        message: info.message || 'Unauthorized'
                                    })
                                })
                            }

                            //success
                            req.user = user;
                            return next();

                        })(req, res, next)
                });
                if (Array.isArray(authProp.permissions) && authProp.permissions.length > 0) {
                    middleware.splice(1, 0, function (req, res, next) {
                        if (authProp.permissions.some((v) => req.user.permissions.indexOf(v) < 0))
                            return res.status(403).format({
                                html: () => res.send('Do not have permissions'),
                                json: () => res.send({
                                    message: 'Do not have permissions'
                                })
                            })
                        next();
                    })
                }
            }

            const corsProp = handlers.cors;
            if (corsProp) {
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
        self.seneca = require('seneca')({
            strict: false,
            timeout: (self.setting.seneca ? self.setting.seneca.timeout : 2 * 60 * 1000) || 2 * 60 * 1000
        });
        self.act = Promise.promisify(seneca.act, {context: self.seneca});
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