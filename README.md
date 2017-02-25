# CircleJS - Core Framework for Micro-service 

### Quy trình triển khai:
1 - Cài đặt (2 cách):

- Sử dụng bộ starter pack:
```bash
git clone https://github.com/paduvi/circle-starter-pack.git
cd circle-starter-pack
```

- Nhúng thư viện Circlejs:
```bash
npm install --save circlejs
```
Mẫu file bootstrap:
```javascript
// server.js

var Application = require('circlejs');

var app = new Application();
app.start();
```

2 - Chạy ở môi trường `Development`: `npm test`

3 - Chạy ở môi trường `Production`: `npm start`

### Cấu trúc folder:
- config: 
    - Trọng số cho ứng dụng: `config.js`
    - Trọng số theo môi trường: `env/config-{env}.js`
    - Cấu hình thông số các kết nối: `setting.js`
    - Cấu hình thông số theo môi trường : `env/setting-{env}.js`
    - Kết nối database: `database.js`, có thể kết nối 1 lúc nhiều database cũng được
- controller:
    - web: cung cấp các REST API (chủ yếu là cho phần frontend)
- action: cung cấp các API dưới dạng hàm (command) cho Resource bên dưới. Sử dụng Seneca, có thể gọi trực tiếp ở service khác thông qua Seneca Client hoặc gọi ở local từ Controller.
- test: thư mục viết test

### Controller:

Các route sẽ được khai báo bên trong các file `controller/{prefix}/{controllerName}/route.js`.
Path được khai báo trong config.js, mặc định nếu không khai báo thì sẽ lấy giá trị là `'web'`
Prefix URL được khai báo trong config.js, mặc định nếu không khai báo thì sẽ lấy giá trị là `''`

Ví dụ route `controller/web/item/route.js` + prefix là `'/api'`:

```
        "/test": {
            get: {
                handler: (req, res) => res.sendStatus(200),
                middleware: [], // optional
                cors: [] //optional,
                authenticate: {
                    name: 'jwt',
                    permissions: ['fashion_manage_all'],
                    // options: {}
                }
            }
        }
```

-> Đường dẫn tương ứng: `/api/item/test`

-> Hàm trên sẽ tương ứng với lệnh `app.get('/api/item/test', [], online.completeVideo)` trong express

-> Danh sách các middleware mình khai báo ở trong phần `middleware` (optional)

-> Khai báo cấu hình authenticate khai báo ở trong phần `authenticate` (yêu cầu phải khai báo`passport:true` trong `config.js`):

-> Danh sách địa chỉ web được phép truy cập AJAX vào service khai báo ở phần `cors` (optional, mặc định là tất cả các request đều được cho phép):
    
    - Tham khảo giá trị config ở trong module cors: https://github.com/expressjs/cors#configuration-options
    - Lưu ý: ở chế độ development, cors sẽ bị tắt.


### Database:

Phần database thay vì fix cứng dùng Sequelize như của Arrowjs.io thì mình sẽ để tự config thoải mái, rồi trả về 1 Promise return ra dbConnection bên trong file `config/database.js`

Ví dụ dùng MongoDB:

```javascript
var MongoClient = require('mongodb').MongoClient;
var Promise = require('bluebird');

exports.beforeInitialize = function (app) {
    return new Promise(function (resolve, reject) {
        MongoClient.connect(`mongodb://${app.config.db.host}/${app.config.db.name}`, function (err, dbConnection) {
            if (err)
                return reject(err);
            resolve({mongo: dbConnection});
        });
    })
}

/* Do something after loading models */
exports.afterInitialize = (app) => {
    return Promise.resolve();
}
```
-> Gọi tới db bằng lệnh `app.db.mongo`

Ví dụ sử dụng nhiều DB 1 lúc:

```javascript
var MongoClient = require('mongodb').MongoClient;
var Sequelize = require('sequelize');
var Promise = require('bluebird');

exports.beforeInitialize = function (app) {
    return Promise.all([
        connectMongo(app),
        connectPostgres(app)
    ]).then(function (results) {
        return {
            mongo: results[0],
            sequelize: results[1]
        }
    })
}

function connectMongo(app) {
    return new Promise(function (resolve, reject) {
        MongoClient.connect(`mongodb://${app.config.db.mongo.host}/${app.config.db.mongo.name}`, function (err, dbConnection) {
            if (err)
                return reject(err);
            resolve(dbConnection);
        });
    })
}

function connectPostgres(app) {
    return Promise.resolve().then(function () {
        let sequelize = new Sequelize(app.setting.db.postgres.database, app.setting.db.postgres.username,
                    app.setting.db.postgres.password, app.setting.db.postgres);
        
        return sequelize.authenticate().then(function () {
            return {sequelize};
        });
    })
}

/* Do something after loading models */
exports.afterInitialize = (app) => {
    return Promise.resolve();
}
```
-> Gọi tới Mongo bằng lệnh `app.db.mongo` và Postgres(Sequelize) bằng lệnh `app.db.sequelize`

### Model
Các model sẽ nằm trong thư mục `model/{db-name}/{model-name}.js`.
Ví dụ: 
- Model `User` của db có tên là `sequelize` sẽ nằm ở `model/sequelize/User.js`
- Lệnh gọi ra: `app.db.sequelize.models.User`

### Action:

Phần Action được khai báo trong folder `action`. Được gọi ra thông qua câu lệnh `app.seneca.act` (cú pháp callback async) hoặc `app.seneca.exec` (cú pháp Promise).

Ví dụ `action/item.js`:

```javascript
module.exports = function (app) {

    let item = app.db.sequelize.models.item;

    return {
        findItem: function (msg, done) {
            return item.findAndCountAll(msg.options).then(function (result) {
                return done(null, result);
            }).catch(function (err) {
                return done(err);
            })
        }

    }

};
```

Lệnh gọi ra action được khai báo ở trên: `app.seneca.exec({role: 'item', cmd: 'findItem', options: opts})`, trong đó:
- `role` chính là tên file: `item`
- `cmd` chính là tên khóa: `findItem`
- các tham số còn lại sẽ được Seneca gom lại vào trong 1 Object, để truyền vào trong hàm Action. Ví dụ tham số `options` được gọi ra thông qua biến `msg.options`
