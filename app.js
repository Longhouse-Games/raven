/*
 * TODO Raven uses 'game' for two metaphors: Game function, and instance of Game function.
 * Let's break it into 'Game' and 'Table'.
 */
var fs = require('fs'),
    express = require('express'),
    logger = require('./lib/logger').logger;

var mongoose = require('mongoose')
    , socketio = require('socket.io')
    , assert = require('assert')
    , cas = require('cas')
    , cookie = require('cookie')
    , http_request = require('request')
    , http = require('http')
    , airbrake = require('airbrake')
    , util = require('util');

var _ = require('underscore'),
    moment = require('moment'),
    EGSNotifier = require('./lib/egs_notifier');

function init (Game) {

  var me = this;

  this.configure = function (options) {
    me.send_index = options.send_index;
    me.send_asset = options.send_asset;
  };

  this.run = function () {

    var MONGO_URL = process.env.MONGO_URL || "mongodb://localhost";
    var DISABLE_CAS = process.env.DISABLE_CAS || false;
    var CAS_HOST = process.env.CAS_HOST || "cas.littlevikinggames.com";
    var CAS_URL = process.env.CAS_URL || "https://" + CAS_HOST + "/login";
    var CAS_HOST_FALLBACK = process.env.CAS_HOST_FALLBACK;
    var CAS_URL_FALLBACK = process.env.CAS_URL_FALLBACK || "https://" + CAS_HOST_FALLBACK + "/login";
    var SERVICE_URL = process.env.SERVICE_URL;
    var PORT = process.env.PORT || 3000;
    var EGS_HOST = process.env.EGS_HOST || "globalecco.org";
    var EGS_PORT = process.env.EGS_PORT || 443;
    var EGS_PROTOCOL = process.env.EGS_PROTOCOL || (EGS_PORT == 443 ? 'https' : 'http')
    var EGS_USERNAME = process.env.EGS_USERNAME;
    var EGS_PASSWORD = process.env.EGS_PASSWORD;
    var EGS_PROFILE_PATH = process.env.EGS_PROFILE_PATH || "/api/secure/jsonws/egs-portlet.gamingprofile/get";
    var EGS_NOTIFICATION_PATH = process.env.EGS_NOTIFICATION_PATH || "/api/secure/jsonws/egs-portlet.gamebot";

    var LOBBY_MODE = process.env.LOBBY_MODE || "webservice";
    var RABBIT_HOST = process.env.RABBIT_HOST || "localhost";
    var RABBIT_USERNAME = process.env.RABBIT_USERNAME || "guest";
    var RABBIT_PASSWORD = process.env.RABBIT_PASSWORD || "guest";
    var RABBIT_VHOST = process.env.RABBIT_VHOST || "";
    var RABBIT_EXCHANGE = process.env.RABBIT_EXCHANGE || "ecco.exchange";


    var PREFIX = process.env.PREFIX || "";
    var AIRBRAKE_API_KEY = process.env.AIRBRAKE_API_KEY;

    var KEY_FILE = process.env.KEY_FILE;
    var CERT_FILE = process.env.CERT_FILE;

    var app;

    var use_ssl = false;

    if (KEY_FILE && CERT_FILE) {
      logger.info("Using SSL");
      use_ssl = true;

      var server_options = {};
      server_options.key = fs.readFileSync(KEY_FILE);
      server_options.cert = fs.readFileSync(CERT_FILE);

      app = express(server_options);
    } else if ((KEY_FILE && !CERT_FILE) || (CERT_FILE && !KEY_FILE)) {
      throw "If one of KEY_FILE or CERT_FILE are specified, you must supply both of them, not just one";
    } else {
      app = express();
    }

    var server = http.createServer(app);
    var io = socketio.listen(server);

    if (AIRBRAKE_API_KEY) {
      var client = airbrake.createClient(AIRBRAKE_API_KEY);
      client.handleExceptions();
      logger.info("Airbrake initialised.");
//  app.error(client.expressHandler()); SEE: https://github.com/felixge/node-airbrake/issues/25
    }

// global variables
    var connectedUsers = 0;

    var metadata = Game.metadata;


// global types
    var Schema = mongoose.Schema;

    var userSchema = new Schema({
      gaming_id: {type: String, default: null },
      cas_handle: {type: String, default: null }
    });
    var User = mongoose.model('User', userSchema);

    var sessionSchema = new Schema({
      session_id: { type: String, default: null },
      gaming_id: {type: String, default: null },
      game_id: {type: String, default: null}
    });
    var Session = mongoose.model('Session', sessionSchema);

    var gameSchema = new Schema({
      is_in_progress: { type: Boolean, default: false },
      roles: function (roles) {
        var results = {};
        for (var i = 0; i < roles.length; i++) {
          results[roles[i].slug] = { type: String, default: null };
        }
        return results;
      }(metadata.roles),
      gameState: String,
      chat_messages: [
        {time: Date, user: String, role: String, message: {type: String, trim: true}}
      ]
    });

    var GameModel = mongoose.model('Game', gameSchema);

    var find_or_create_session = function (gaming_id, session_id, next) {
      Session.findOne({ session_id: session_id }, function (err, session) {
        if (err) {
          throw err;
        }
        if (session) {
          next(session);
        } else {
          session = new Session({ session_id: session_id, gaming_id: gaming_id });
          session.save(function (err) {
            if (err) {
              throw err;
            }
            next(session);
          });
        }
      });
    }
// next takes the found/created user as parameter
    var find_or_create_user = function (profile, session_id, next) {
      var gaming_id = profile.gamingId;
      find_or_create_session(gaming_id, session_id, function (session) {
        User.findOne({ gaming_id: gaming_id }, function (err, user) {
          if (err) {
            throw err;
          }
          if (user) {
            next(user);
          } else {
            var user = new User({ gaming_id: gaming_id, cas_handle: profile.casId });
            user.save(function (err) {
              if (err) {
                throw err;
              }
              next(user);
            });
          }
        });
      });
    };

    function authenticate_with_cas (request, response, callback) {
      if (DISABLE_CAS) {
        var handle = request.query.handle;
        logger.debug("DISABLE_CAS is true. Skipping authentication for " + handle);
        callback(handle);
        return;
      }

      var serviceTicket = request.query.ticket;
      var hasServiceTicket = typeof serviceTicket !== 'undefined';

      var host = CAS_HOST;
      var cas_url = CAS_URL;

      if (request.query.cas == "test") {
        host = CAS_HOST_FALLBACK;
        cas_url = CAS_URL_FALLBACK;
      }

      var protocol = use_ssl ? "https://" : "http://";
      logger.debug("Request.url: " + request.url);
      var path = request.url.replace(/[&|\?]?ticket=[\w|-]+/i, "");
      logger.debug("Path: " + path);
      var serviceURL = SERVICE_URL || (protocol + request.headers.host);
      serviceURL += path;
      logger.debug("CAS service: " + serviceURL);
      var loginUrl = cas_url + '?service=' + encodeURIComponent(serviceURL);
      logger.debug("CAS Login URL: " + loginUrl);

      var base_url = "https://" + host;
      var casInstance = new cas({
        base_url: base_url,
        service: serviceURL,
        https: {
          rejectUnauthorized: false
        }
      });

      // initial visit
      if (!hasServiceTicket) {
        logger.info("Redirecting to CAS Login");
        response.redirect(loginUrl);
        return;
      }

      logger.info("Got service ticket: " + serviceTicket);

      // validate service ticket
      casInstance.validate(serviceTicket, function (error, status, cas_handle) {
        logger.info("Validated ticket.");
        if (error) {
          logger.error("Error validating CAS: ", error);
        }
        if (error || !status) {
          response.redirect(loginUrl);
          return;
        }
        callback(cas_handle);
      });
    }

    function handleLogin (request, response, game_id, callback) {

      logger.info("Handling Login!");

      applyHeaders(response);

      authenticate_with_cas(request, response, function (cas_handle) {
        logger.info(cas_handle + " logged in! SessionID: " + request.cookies['express.sid']);
        getPlayerProfile(cas_handle, game_id, function (error, profile) {
          if (error) {
            respond_with_error(response, error);
            return;
          }
          if (!profile) {
            respond_with_error(response, "Unable to retrieve player profile.");
            return;
          }
          find_or_create_user(profile, request.cookies['express.sid'], function (user) {
            callback(user);
          });
        });
      });
    }

    applyHeaders = function (res) {
      res.header("Cache-Control", "max-age=600");
    };

    app.configure(function () {
      app.use(express.cookieParser());
      app.use(express.session({secret: 'secret', key: 'express.sid'}));
    });

    serve_path = function (req, res, path) {
      applyHeaders(res);
      logger.debug("Serving: " + path);
      me.send_asset(req, res, path);
    }
    serve_lib = function (req, res) {
      var path = req.originalUrl.replace(new RegExp(PREFIX, ""), "");
      serve_path(req, res, path);
    }
    serve_assets = function (req, res) {
      var path = "/assets" + req.originalUrl.replace(new RegExp(PREFIX, ""), "");
      serve_path(req, res, path);
    }

    authenticateAppServer = function (req, res, callback) {
      //TODO implement
      callback();
    };

    handleNew = function (req, res) {
      logger.debug("New game requested.");
      authenticateAppServer(req, res, function () {
        return createGameFromWebRequest(req, res);
      });
    };

    handlePlay = function (req, res) {
      logger.debug("/play requested.");
      var game_id = req.param('gid');
      if (!game_id) {
        res.send("gid is a required parameter", 400);
        return;
      }
      handleLogin(req, res, game_id, function (user) {
        return playGame(req, res, game_id, user);
      });
    };

    var egs_response = function (req, res, params, next) {
      if (!params.stat) {
        throw "Params.stat is required";
      }

      var format = "xml";
      if (req.param('fmt')) {
        format = req.param('fmt').toLowerCase();
      }

      var code = params.stat === "ERROR" ? 400 : 200;
      if (format === "xml") {
        var body = "<stat>" + params.stat + "</stat>";
        if (params.msg) {
          body = body + "<msg>" + params.msg + "</msg>";
        }
        if (params.game_id) {
          body = body + "<glst><cnt>1</cnt><game><gid>" + params.game_id + "</gid></game></glst>";
        }
        res.send(body, { 'Content-Type': 'application/xml' }, code);
      } else if (format === "json") {
        var json = { stat: params.stat };
        if (params.msg) {
          json.msg = params.msg;
        }
        if (params.game_id) {
          json.glst = {
            cnt: 1,
            game: { gid: params.game_id }
          };
        }
        res.json(json, code);
      } else if (format === "html" && req.param("dbg") === "1") {
        var role1 = metadata.roles[0];
        var role2 = metadata.roles[1];
        var html = "";
        if (!process.env.DISABLE_CAS) {
          html = html + "<b>With ECCO CAS server:</b><br>";
          html = html + "<a href='" + PREFIX + "/play?gid=" + params.game_id + "&role=" + role1.slug + "&handle=" + req.param(role1.slug) + "&app=BRSR'>Join game '" + params.game_id + "' as " + role1.name + "</a> (" + req.param(role1.slug) + ")<br>";
          html = html + "<a href='" + PREFIX + "/play?gid=" + params.game_id + "&role=" + role2.slug + "&handle=" + req.param(role2.slug) + "&app=BRSR'>Join game '" + params.game_id + "' as " + role2.name + "</a> (" + req.param(role2.slug) + ")<br>";
          html = html + "<hr><b>With test CAS server:</b><br>";
        }
        html = html + "<a href='" + PREFIX + "/play?gid=" + params.game_id + "&cas=test&role=" + role1.slug + "&handle=" + req.param(role1.slug) + "&app=BRSR'>Join game '" + params.game_id + "' as " + role1.name + "</a> (" + req.param(role1.slug) + ")<br>";
        html = html + "<a href='" + PREFIX + "/play?gid=" + params.game_id + "&cas=test&role=" + role2.slug + "&handle=" + req.param(role2.slug) + "&app=BRSR'>Join game '" + params.game_id + "' as " + role2.name + "</a> (" + req.param(role2.slug) + ")<br>";
        res.send(html, { 'Content-Type': 'text/html' }, code);
      } else {
        res.send("Invalid format: " + req.fmt + ". Must be one of 'json' or 'xml'", 400);
      }
      if (typeof next === 'function') {
        next();
      }
    };

    var egs_error_response = function (req, res, message) {
      return egs_response(req, res, {
        stat: "ERROR",
        msg: message
      });
    };

    var egs_game_response = function (req, res, game_id, next) {
      egs_response(req, res, {
        stat: "OK",
        game_id: game_id
      }, next);
    };


    var getPlayerProfile = function (cas_handle, game_id, callback) {
      logger.debug("getPlayerProfile() called with cas_handle: " + cas_handle + ", and gameid: " + game_id);
      var path = EGS_PROFILE_PATH + "?ver=1.0&title=" + metadata.slug + "&gid=" + encodeURIComponent(game_id) + "&email=" + encodeURIComponent(cas_handle);

      var auth = (EGS_USERNAME && EGS_PASSWORD) ? (encodeURIComponent(EGS_USERNAME) + ":" + EGS_PASSWORD + "@") : "";
      var url = EGS_PROTOCOL + "://" + auth + EGS_HOST + ":" + EGS_PORT + path;
      var opts = {
        url: url,
        method: 'GET'
      };
      logger.debug("Opts for request:", opts);
      http_request(opts, function (error, response, body) {
        if (error) {
          logger.error("Error getting gaming profile from EGS. Error: " + error);
          callback("Unable to retrieve gaming profile for " + cas_handle);
          return;
        }
        if (response.statusCode !== 200) {
          logger.error("Error getting gaming profile from EGS. Response code: " + (response.statusCode || 'none'));
          logger.error(body);
          callback("Unable to retrieve gaming profile for " + cas_handle);
          return;
        }

        logger.debug("Response from EGS: " + body);
        /*
         {
         "gameInstanceId": "xxx",
         "gamingId":"xxxxxxx",
         "casId": "some email address"
         }
         */
        var response = JSON.parse(body);
        if (response.exception) {
          callback(response.exception, null);
        } else {
          callback(null, response);
        }
        return;
      });
    };

    var respond_with_error = function (response, message) {
      logger.error("Error: " + message);
      response.send(message, 400);
    };


    var createGame = function(lang, debug, app, role1, role2, player1, player2) {

      if (!player1 || !player2) {
        logger.error("Got invalid request for new game:");
        logger.error(req.query);
        return egs_error_response(req, res, "Both roles must be provided (" + role1.slug + " and " + role2.slug + ")");
      }

      var roles = {};
      roles[role1.slug] = player1;
      roles[role2.slug] = player2;
      var dbgame = new GameModel({
        is_in_progress: true,
        roles: roles
      });
      dbgame.save(function (err, game) {
        if (err) {
          throw err;
        }

        logger.debug("Created game: " + game._id + ". Roles: " + game.roles);
      });

      return {roles: roles, dbgame: dbgame};
    };

    var createGameFromAMQPRequest = function(message) {
      logger.debug("Back in raven...");
      logger.debug(message.toString());

      var req = JSON.parse(message.toString());
      logger.debug(JSON.stringify(req));

      logger.debug("Slug0 = " + metadata.roles[0].slug);
      logger.debug("Slug1 = " + metadata.roles[1].slug);
      var r1 = metadata.roles[0].slug;
      var r2 = metadata.roles[1].slug;
      var player1 = req[r1];
      var player2 = req[r2];

      logger.debug("Player1 = " + player1);
      logger.debug("Player2 = " + player2);


      var game_spec = createGame(req.lang, req.debug, req.app,  metadata.roles[0],  metadata.roles[1], player1, player2)

      // Wrong time for this since the
      // new game ackn hasn't even been sent yet.
      // notification_service.setPlayerState(Game.initialPlayerState(), game_spec.dbgame._id, game_spec.roles);
      game_spec.initialPlayerState = Game.initialPlayerState();
      return game_spec;
    };

    var createGameFromWebRequest = function (req, res) {
      logger.debug("Creating game.");
      var lang = req.lang;
      var debug = req.debug;
      var app = req.app;
      var role1 = metadata.roles[0];
      var role2 = metadata.roles[1];
      var player1 = req.param('role1') || req.param(role1.slug);
      var player2 = req.param('role2') || req.param(role2.slug);

      var game_spec = createGame(lang, debug, app, role1, role2, player1, player2);

      egs_game_response(req, res, game_spec.dbgame._id, function () {
        notification_service.setPlayerState(Game.initialPlayerState(), game_spec.dbgame._id, game_spec.roles);
      });

    };

    var notification_service = new EGSNotifier.EGSNotifier({
      mode: LOBBY_MODE,
      host: LOBBY_MODE === "webservice" ? EGS_HOST : RABBIT_HOST,
      port: EGS_PORT,
      username: LOBBY_MODE === "webservice" ? EGS_USERNAME : RABBIT_USERNAME,
      password: LOBBY_MODE === "webservice" ? EGS_PASSWORD : RABBIT_PASSWORD,
      notification_path: EGS_NOTIFICATION_PATH,
      amqp_vhost: RABBIT_VHOST,
      amqp_exchange: RABBIT_EXCHANGE,
      game_title: metadata.slug,
      game_version: '1.0',
      amqp_newHandler: createGameFromAMQPRequest
    });

    var playGame = function (req, res, game_id, user) {
      logger.debug("Request to play game '" + game_id + "' from user:", user);
      var role = req.param('role');

      if (!role) {
        res.send("role is a required parameter", 400);
        return;
      }
      if (role !== metadata.roles[0].slug && role !== metadata.roles[1].slug) {
        res.send("role must be one of '" + metadata.roles[0].slug + "' or '" + metadata.roles[1].slug + "'");
        return;
      }

      GameModel.findOne({_id: game_id}, function (err, game) {
        if (err || !game) {
          logger.error("Error looking up game '" + game_id + "'");
          res.send("Could not find game with id: " + game_id, 400);
          return;
        }
        logger.debug("Found game: " + game_id);
        logger.debug(game);

        logger.debug("User:");
        logger.debug(user);

        var requested_nickname = game.roles[role];
        if (user.gaming_id !== requested_nickname) {
          respond_with_error(res, "Requested game role ('" + requested_nickname + "') does not match the logged in user ('" + user.gaming_id + "').");
          logger.debug("Requested role: " + role + ", saved handle: " + requested_nickname + ", current handle: " + user.gaming_id);
          return;
        }

        // TODO HACK temporary hack to quickly lookup game_id after they connect with websockets
        Session.findOne({session_id: req.cookies['express.sid']}, function (err, session) {
          if (err) {
            logger.error("Error looking up session for: " + req.cookies['express.sid']);
            res.send("Could not find session. Try reconnecting.", 400);
            return;
          }

          session.game_id = game_id;
          logger.debug("Saved game_id to session.");
          session.save(function (err) {
            if (err) {
              throw err;
            }

            logger.debug("Playing game: " + game_id);
            me.send_index(req, res);
          });
        });
      });
    };

    app.post(PREFIX + '/new', function (req, res) {
      handleNew(req, res);
    });
    app.get(PREFIX + '/new', function (req, res) {
      handleNew(req, res);
    });
    app.post(PREFIX + '/play', function (req, res) {
      handlePlay(req, res);
    });
    app.get(PREFIX + '/play', function (req, res) {
      handlePlay(req, res);
    });

    app.get(PREFIX + '/credits', function (req, res) {
      var md = require("node-markdown").Markdown;
      fs.readFile('CREDITS.md', 'utf-8', function (err, credits) {
        if (err) {
          logger.err("Error reading CREDITS.md", err);
          res.send("Error!");
          return;
        }
        var html = md(credits);
        res.header("Content-Type", "text/html");
        res.send(html);
      });
    });
    app.get(PREFIX + '/status', function (req, res) {
      res.send("Okay!");
    });
    app.get(PREFIX + '/lib/*', serve_lib);
    app.get(PREFIX + '/*', serve_assets);
    var debug = function (req, res) {
      res.header("Content-Type", "text/html");
      var html = "";
      html += "<p>Hi! I'm a Raven instance running '" + metadata.name + "' at '" + req.headers.host + "'.</p>";
      html += "<p>req url: " + req.url + "</p><hr>";
      html += "<p>Query: <br><pre>" + JSON.stringify(req.query, null, '\t') + "</pre></p><hr>";
      html += "<p>ENV VARS: <br><pre>" + JSON.stringify(process.env, null, '\t') + "</pre></p>";

      res.send(html);
    };
// app.get(PREFIX+'/', debug);
// app.get('/*', debug);

//Clients should set their resource to 'PREFIX/socket.io', minus the initial trailing slash
    io.set('resource', PREFIX + "/socket.io");
    io.set('authorization', function (data, accept) {
      // check if there's a cookie header
      if (data.headers.cookie) {
        // if there is, parse the cookie
        data.cookie = cookie.parse(data.headers.cookie);
        // note that you will need to use the same key to grad the
        // session id, as you specified in the Express setup.
        data.sessionID = data.cookie['express.sid'];
      } else {
        // if there isn't, turn down the connection with a message
        // and leave the function.
        return accept('No cookie transmitted.', false);
      }
      // accept the incoming connection
      accept(null, true);
    });

    var Table = function (dbgame) {
      var table = this;
      var game;
      var players = {}; //indexed by gaming_id
      var draw_offered_by = dbgame.draw_offered_by; //keeps track of whether a draw has been offered and by whom
      var game_id = dbgame._id;
      this.setDrawOfferedBy = function (val) {
        table.draw_offered_by = val;
        dbgame.draw_offered_by = val;
        dbgame.save(function (err) {
          if (err) throw err;
        });
      };

      var roles = {};
      _.each(metadata.roles, function (role) {
        roles[role.slug] = dbgame.roles[role.slug];
      });

      var raven = {
        broadcast: function (message, data) {
          _.each(players, function (player, gaming_id) {
            player.socket.emit(message, data);
          });
        },
        save: function (gameStateDTO) {
          dbgame.gameState = JSON.stringify(gameStateDTO);
          dbgame.save(function (err) {
            if (err) throw err;
          });
        },
        /*
         * Portal notification methods
         */

        /*
         * Sets the waiting state for each role specified in `state`.
         * `state` is an object which has roles for properties and their attention
         * state for values. Valid values are "ATTN" and "PEND".
         *
         * "ATTN" indicates that the game is waiting for this player to
         * provide input (for example, to take their turn). "PEND" means that
         * the game is not waiting on this player (for example, it is the other
         * player's turn).
         *
         * Example state:
         * {
         *   white: "ATTN",
         *   black: "PEND"
         * }
         *
         * As a short cut, one can call setPlayerState(role, state), which is the
         * equivalent of doing setPlayerState({ role: state })
         */
        setPlayerState: function (state) {
          if (arguments.length === 2) {
            var singleState = {}
            singleState[arguments[0]] = arguments[1];
            notification_service.setPlayerState(singleState, game_id, roles);
//            egs_notifier.setPlayerState(singleState);
          } else {
            notification_service.setPlayerState(state, game_id, roles);
//            egs_notifier.setPlayerState(state);
          }
        },
        ATTN: "ATTN", // Indicates that the game is waiting for the player
        PEND: "PEND", // Indicates that the game is not waiting for the player
        OVER: "OVER", // Indicates that this player is done with the game.
        /*
         * Indicate that the player in `role` has forfeit the game
         */
        forfeit: function (role) {
          notification_service.forfeit(role, game_id, roles);
//          egs_notifier.forfeit(role);
        },
        /*
         * Indicate that the game is over. The winner is specified by
         * `winning_role`. `scores` contains the final scores
         */
        gameover: function (winning_role, scores) {
          notification_service.gameover(winning_role, scores, game_id, roles);
//          egs_notifier.gameover(winning_role, scores);
        }
      };

      if (_.isUndefined(dbgame.gameState) || dbgame.gameState === null) {
        logger.info("Creating new game: " + dbgame._id);
        game = Game(raven);
      } else {
        logger.debug("Restoring old game: " + dbgame._id);
        game = Game(raven, JSON.parse(dbgame.gameState));
      }

      var addPlayer = function (socket, user, role) {
        players[user.gaming_id] = { user: user, socket: socket, role: role};

        socket.emit('userdata', { username: user.gaming_id, role: role });

        game.addPlayer(socket, user, role);

        raven.broadcast('user_online', user.gaming_id);
        socket.emit('chat_history', dbgame.chat_messages);

        if (table.draw_offered_by && table.draw_offered_by !== user.gaming_id) {
          socket.emit('draw_offered', {by: table.draw_offered_by});
        }

        var handleError = function (callback, data) {
          try {
            var result = callback(data);
            return result;
          } catch (e) {
            socket.emit('error', e);
            console.log("Error: ", e);
            console.log(e.stack);
          }
        };

        var logAndHandle = function (message, callback) {
          socket.on(message, function (data) {
            console.log("[" + user.gaming_id + "] " + message + ": ", data);

            return handleError(callback, data);
          });
        };

        logAndHandle('message', function (message) {
          message = {user: user.gaming_id, message: message.message, role: role, time: new Date()};
          dbgame.chat_messages.push(message);
          dbgame.save();
          raven.broadcast('message', message);
        });

        logAndHandle('offer_draw', function () {
          console.log(user.gaming_id + " is offering a draw.");
          if (!game.hasStarted()) {
            throw "Game has not started yet!";
          }
          if (table.draw_offered_by) {
            throw "Draw has already been offered!";
          }
          table.setDrawOfferedBy(user.gaming_id);

          raven.broadcast('draw_offered', {by: user.gaming_id});
        });

        logAndHandle('accept_draw', function () {
          console.log(user.gaming_id + " has accepted the draw offer");
          if (!table.draw_offered_by) {
            throw "No draw has been offered!";
          }
          if (user.gaming_id === table.draw_offered_by) {
            throw "You cannot accept your own draw!";
          }
          raven.broadcast('draw_accepted', null);
          game.draw();
          table.setDrawOfferedBy(null);
          notification_service.draw(game_id, roles);
//          egs_notifier.draw();
        });

        logAndHandle('reject_draw', function () {
          if (!table.draw_offered_by) {
            throw "No draw has been offered!";
          }
          if (user.gaming_id === table.draw_offered_by) {
            throw "You cannot reject your own draw!";
          }
          raven.broadcast('draw_rejected', null);
          console.log(user.gaming_id + " has rejected the draw offer");
          table.setDrawOfferedBy(null);
        });

        socket.on('disconnect', function (socket) {
          delete players[user.gaming_id];
          raven.broadcast('user_offline', user.gaming_id);
          logger.info(user.gaming_id + " disconnected.");
          logger.info('connected users: ', totalUsers());
        });

        logger.debug('joined table');
        logger.debug('active tables: ' + tables.length);
        logger.info('connected users: ' + totalUsers());
      }

      return {
        game: game,
        dbgame: dbgame,
        addPlayer: addPlayer
      };
    };
// TODO tables are currently never unloaded. Should unload them after all players disconnect
    var tables = [];

    var totalUsers = function () {
      return _.reduce(tables, function (accum, table) {
        return accum + table.game.getPlayerCount();
      }, 0)
    };

    var findTable = function (dbgame) {
      var i = 0;
      for (i = 0; i < tables.length; i++) {
        tmp = tables[i].dbgame;
        if (tmp._id.equals(dbgame._id)) {
          return tables[i];
        }
      }
      return null;
    }


    var handleSessionError = function (socket) {
      socket.emit('session_error', "Invalid socket session. Please refresh your browser.");
    };

    io.sockets.on('connection', function (socket) {
      if (!socket.handshake.sessionID) {
        // This occurs when a client reconnects after server restarts
        handleSessionError(socket);
        return;
      }
      Session.findOne({session_id: socket.handshake.sessionID}, function (err, session) {
        if (err) {
          throw "Error looking up session: " + err;
        }
        if (!session) {
          handleSessionError(socket);
          return;
        }
        var game_id = session.game_id;
        GameModel.findOne({_id: game_id}, function (err, dbgame) {
          if (err || !dbgame) {
            logger.error("Unable to lookup game: " + game_id);
            socket.emit('error', "Unable to lookup requested game. Try refreshing your browser.");
            return;
          }
          User.findOne({gaming_id: session.gaming_id}, function (err, user) {
            if (err || !user) {
              logger.error("Unable to look up user by user.gaming_id '" + user.gaming_id + "': " + err);
              socket.emit('error', "Unable to look up user. Try refreshing your browser.");
              return;
            }
            var role;
            _.find(dbgame.roles, function (gaming_id, role_slug) {
              role = role_slug;
              return gaming_id === user.gaming_id;
            });
            var table = findTable(dbgame);
            if (!table) {
              table = Table(dbgame);
              logger.debug("Stuffing game into tables: " + dbgame._id);
              tables.push(table);
            }
            table.addPlayer(socket, user, role);
          });
        });
      });
    });

    var options = { server: { socketOptions: { connectTimeoutMS: 10000 }}};

// lvg-<metadata.slug>  is the mongo DATABASE instance
// If local, then this turns out to be something like lvg-guerrilla-checkers
// If remote, like on a Mongo service (MongoHQ), then the database name is 
// predetermined by their subscriber configuration.  It seems safe, however,
// because MongoHQ appears to simply ignore the extra info after the database
// name, for example if you privide a MONGO_URL that has a database in it:
//
// mongodb://<user>:<passwd>@chang.mongohq.com:10005/abcdefg
//
// the collections get instantiated in that database, and the string here
//
//  '/lvg-guerrilla-checkers'
//
// is ignored.
//
//  NOTE: you can get free developer instances at MongoHQ to test this from
//  a local dev machine.
//
// Of course, this means any Raven game needs to be on
// an independent MongoHQ instance, since the 'lvg-' configuration string
// is not operative and thus has no opportunity to ensure a private data space.
// It might be nice in the future to plan for mulit-tennancy of Raven games
// in the same database instance.  I guess this would mean prefixing collection
// names with something unique about the current application instance.
//

    mongoose.connect(MONGO_URL + '/lvg-' + metadata.slug, options, function (err) {
      if (err) {
        throw err;
      }
    });

    server.listen(PORT, function () {
      logger.info("[" + new Date() + "] " + metadata.name + " listening on http://localhost:" + PORT + PREFIX);
    });


  }; // function run()

  return {
    run: me.run,
    configure: me.configure
  };
};

exports.init = init;
