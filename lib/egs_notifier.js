var logger = require('./logger').logger,
    amqp = require('amqplib'),
    when = require('when'),
    request = require('request'),
    _ = require('underscore');

var EGSNotifier = function (options) {
      var req = function (val) {
        if (!options[val]) {
          throw "EGSNotifier(): " + val + " is a required option";
        }
        return options[val];
      };
      this.mode = req('mode');
      this.host = req('host');
      this.port = options.port || 443;
      this.protocol = options.protocol || (this.port == 443 ? 'https' : 'http')
      this.username = options.username;
      this.password = options.password;
      this.notification_path = req('notification_path');


      if (this.mode === "amqp") {
        logger.info("Starting amqp connection");
        this.vhost = options.amqp_vhost;
        this.exchange = req('amqp_exchange');
        this.newGameCallback = req('amqp_newHandler');

        var vh = (this.vhost.length > 0) ? "/" + this.vhost : this.vhost;
        var connectURL = "amqp://" + this.username + ":" + this.password + "@" + this.host + vh;
        logger.debug("AMQP Connect String is: " + connectURL);
        logger.debug("AMQP exhange: " + this.exchange);
        logger.debug("AMQP notification path: " + this.notification_path);
        var that = this;
        amqp.connect(connectURL).then(function (conn) {
              var ok = conn.createChannel();
              ok = ok.then(function (ch) {

                function newHandler (msg) {

                  var game_spec = that.newGameCallback(msg.content);
                  logger.debug("New Game spec: " + JSON.stringify(game_spec));
                  var stateUpdate = that.getPlayerStateUpdate(game_spec.initialPlayerState, game_spec.dbgame._id, game_spec.roles);

                  var response = {
                    stat: "OK",
                    glst: {
                      cnt: 1,
                      game: {gid: game_spec.dbgame._id}
                    },
                    update: stateUpdate
                  };

                  logger.debug("New Game response: " + JSON.stringify(response));

                  ch.sendToQueue(msg.properties.replyTo,
                      new Buffer(JSON.stringify(response)),
                      {correlationId: msg.properties.correlationId});
                  ch.ack(msg);


                };

                // inject a method into the notifier that is closed by the amqp connect context.
                that.deliverViaAMQP = function (options) {

                  logger.debug("Got deliverViaAMQP: " + JSON.stringify(options));

                  // once we can throw off the legacy game lobby, we can get rid of this extra
                  // packaging.

                  var body = that.buildWrapper(options);

                  ch.sendToQueue(that.notification_path,
                      new Buffer(JSON.stringify(body)));
                };

                // Expose a profile-getting service on EGSNotifier
                that.getPlayerProfile = function (cas_handle, game_id) {

                };

                return when.all([
                  ch.checkExchange(that.exchange),
                  ch.checkQueue('gc.queue'),
                  ch.checkQueue(that.notification_path),
                  ch.bindQueue(that.notification_path, that.exchange, "ecco.binding.#"),
                  ch.bindQueue('gc.queue', that.exchange, "ecco.binding.#"),
                  ch.consume('gc.queue', newHandler)
                ]);
              });

              return ok;
            }
        ).
            then(null, console.warn);
      }

      this.game_title = req('game_title');
      this.game_version = req('game_version');
      this.STATES = {
        PEND: "PEND",
        ATTN: "ATTN",
        OVER: "OVER"
      };
      logger.debug("EGS Notifier started for host: " + this.host);

      this.deliverViaWebservice = function (options) {

        var path = this.notification_path;
        var auth = (this.username && this.password) ? (encodeURIComponent(this.username) + ":" + this.password + "@") : "";
        var url = this.protocol + "://" + auth + this.host + ":" + this.port + path;

        var opts = {
          url: url,
          method: 'POST',
          headers: { "Content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(this.buildWrapper(options))
        };
        logger.debug("Opts for request:", opts);

        request(opts, function (error, response, body) {
          if (error) {
            logger.error("Error notifying EGS. Error: " + error);
            return;
          }
          if (response.statusCode !== 200) {
            logger.error("Error notifying EGS. Response code: " + (response.statusCode || 'none'));
            logger.error(body);
            return;
          }

          logger.debug("Response from EGS: " + body);
          return;
        });
      };

      this.deliver = function (options) {

        if (this.mode === "webservice") {
          this.deliverViaWebservice(options);
        } else {
          this.deliverViaAMQP(options);
        }
      };

      this.buildUpdate = function (options) {
        var update = {
          "gameInstanceId": options.game_id,
          "gameTitle": this.game_title,
          "gameVersion": this.game_version,
          "gamingId": options.gamingId,
          "state": options.state
        };
        if ('score' in options) {
          update['score'] = options['score'];
        }
        if (options['outcome']) {
          update['outcome'] = options['outcome'];
        }
        return update;
      };
      this.buildWrapper = function (options) {
        var payload = {}
        if (options.update) {
          if (options.update.length === 1) {
            payload.update = options.update[0];
          } else {
            payload.update = options.update;
          }
        }
        if (options.outcomes) {
          payload.outcomes = options.outcomes;
        }
        return {
          "method": "game-updates",
          "id": 7224,
          "jsonrpc": "2.0",
          "params": {
            "payload": payload
          }
        }
      };
    }
    ;

EGSNotifier.prototype.move = function (role, game_id, players) {
  var me = this;
  var updates = _.map(
      _.reject(players, function (gaming_id, role_slug) {
        return role === role_slug;
      }),
      function (gaming_id) {
        logger.info("EGSNotifier: Notifying EGS that it's not " + gaming_id + "'s turn");
        return me.buildUpdate({gamingId: gaming_id, state: me.STATES.PEND, game_id: game_id});
      }
  );
  logger.info("EGSNotifier: Notifying EGS that it's " + players[role] + "'s turn");
  updates.push(this.buildUpdate({gamingId: players[role], state: this.STATES.ATTN, game_id: game_id}));
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.validateRole = function (role, players) {
  if (!players[role]) {
    throw "Invalid role: " + role;
  }
};

EGSNotifier.prototype.validateState = function (state) {
  if (!_.find(this.STATES, function (s) {
    return s === state;
  })) {
    throw "Invalid state: '" + state + "'. Must be one of the values in EGSNotifier.STATES.";
  }
};

/*
 * Gets a waiting state update object for each role specified in `state`.
 * `state` is an object which has roles for properties and their attention
 * state for values. Valid values are "ATTN", "PEND" and "OVER".
 *
 * "ATTN" indicates that the game is waiting for this player to
 * provide input (for example, to take their turn). "PEND" means that
 * the game is not waiting on this player (for example, it is the other
 * player's turn).  OVER indicates that this game instance will no longer
 * accept moves.
 *
 * Factored out of setPlayerState so that an update record can easily be
 * generated and added to other notification message types (such as the
 * response message for new game requests.
 */
EGSNotifier.prototype.getPlayerStateUpdate = function (states, game_id, players) {
  var role, state;
  var updates = [];

  for (role in states) {
    if (states.hasOwnProperty(role)) {
      state = states[role];
      this.validateRole(role, players);
      this.validateState(state);
      updates.push(this.buildUpdate({gamingId: players[role], state: state, game_id: game_id}));
    }
  }
  return updates;
};

/**
 * Generate a state update object, and send it to the lobby.
 */
EGSNotifier.prototype.setPlayerState = function (states, game_id, players) {
  var updates = this.getPlayerStateUpdate(states, game_id, players);
  if (updates.length === 0) {
    return;
  }
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.forfeit = function (forfeiting_role, game_id, players) {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that " + forfeiting_role + " has forfeited and the game " + game_id + " is over.");
  var updates = _.map(players, function (gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      score: 0
    }
    if (gaming_id === players[forfeiting_role]) {
      options.outcome = "Forfeit";
    } else {
      options.outcome = "Win";
    }

    options.game_id = game_id;

    return me.buildUpdate(options);
  });
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.draw = function (game_id, players) {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that the game is a draw.");
  var updates = _.map(players, function (gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      outcome: "Draw"
    }
    options.game_id = game_id;
    return me.buildUpdate(options);
  });
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.gameover = function (winning_role, scores, game_id, players) {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that it's gameover.");

  var scores_with_ids = {};
  _.each(scores, function (score, role) {
    scores_with_ids[players[role]] = score;
  });

  var updates = _.map(players, function (gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      score: scores[role]
    }
    if (gaming_id === players[winning_role]) {
      options.outcome = "Win";
    } else {
      options.outcome = "Lose";
    }
    options.game_id = game_id;
    return me.buildUpdate(options);
  });

  return this.deliver({ update: updates });
};

exports.EGSNotifier = EGSNotifier;

