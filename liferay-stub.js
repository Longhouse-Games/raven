var express = require('express');
var logger = require('./lib/logger').logger;

var port = process.env.EGS_PORT || 4000;
if (process.argv && process.argv[2])
{
  port = process.argv[2];
}
var app = express.createServer(
  express.logger()
);

function rawBody(req, res, next) {
  req.setEncoding('utf8');
  req.rawBody = '';
  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function(){
    next();
  });
}

app.configure(function() {
  app.use(rawBody);
});

app.post('/api/secure/jsonws/egs-portlet.gamebot', function(req, res) {
  var ctype = req.header('Content-Type');
  if (ctype !== "application/json; charset=utf-8") {
    var response = {
      "Status": "Error",
      "System Version": "0.1.0",
      "Method": "update-gamestate",
      "Format Error": "Invalid content type. Must be 'text/plain; charset=utf-8'. You sent: "+ctype,
      "System Name": "ECCO Game Services"
    }
    res.send(response);
    return;
  }
  var payload = JSON.parse(req.rawBody).params.payload;
  logger.debug("lobby update received " + payload);
  var updates = payload.updates;
  if (updates)
    logger.debug(updates);
  var response = {
    "Status": "OK",
    "System Version": "0.1.0",
    "Method": "update-gamestate",
    "Updates Processed": "1",
    "System Name": "ECCO Game Services"
  };
  res.send(response);
});

app.get('/api/secure/jsonws/egs-portlet.gamingprofile/get', function(req, res) {

  logger.debug("get profile " + req.param('email'));
  var results = {
    gameInstanceId: "foo",
    gamingId: "bar",
    casId: "baz"
  };
  var email = req.param('email');
  if (email) {
    results.casId = email;
    results.gamingId = {
      "foo": "foo",
      "bar": "bar",
      "obs": "obs"
    }[email];
  }
  logger.debug("returning " + results);
  res.send(results);
});

app.all('/*', function(req, res, next) {
  res.send('received');
});
app.listen(port);
console.log('server listening on: ' + port);

