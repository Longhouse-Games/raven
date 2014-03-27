var logger    = require('./logger').logger,
    request   = require('request')
    _ = require('underscore');

var EGSNotifier = function(options) {
  var req = function(val) {
    if (!options[val]) {
      throw "EGSNotifier(): "+val+" is a required option";
    }
    return options[val];
  };
  this.host = req('host');
  this.port = options.port || 443;
  this.protocol = options.protocol || (this.port == 443 ? 'https' : 'http')
  this.username = options.username;
  this.password = options.password;
  this.notification_path = options.notification_path;
  this.game_id = req('game_id');
  this.game_title = req('game_title');
  this.game_version = req('game_version');
  this.players = req('players');
  this.STATES = {
    PEND: "PEND",
    ATTN: "ATTN",
    OVER: "OVER"
  };
  logger.debug("EGS Notifier started for host: "+this.host);

  this.deliver = function(options) {
    var path = this.notification_path;
    var auth = (this.username && this.password) ? (encodeURIComponent(this.username)+":"+this.password+"@") : "";
    var url = this.protocol+"://"+auth+this.host+":"+this.port+path;
    var opts = {
      url: url,
      method: 'POST',
      headers: { "Content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(this.buildWrapper(options))
    };
    logger.debug("Opts for request:", opts);
    request(opts, function(error, response, body) {
      if (error) {
        logger.error("Error notifying EGS. Error: " + error);
        return;
      }
      if (response.statusCode !== 200) {
        logger.error("Error notifying EGS. Response code: " + (response.statusCode || 'none') );
        logger.error(body);
        return;
      }

      logger.debug("Response from EGS: " + body);
      return;
    });
  };
  this.buildUpdate = function(options) {
    var update = {
     "gameInstanceId": this.game_id,
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
  this.buildWrapper = function(options) {
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
       "jsonrpc":"2.0",
       "params": {
          "payload": payload
       }
    }
  };
};

EGSNotifier.prototype.move = function(role) {
  var me = this;
  var updates = _.map(
      _.reject(this.players, function(gaming_id, role_slug) {
        return role === role_slug;
      }),
      function(gaming_id) {
        logger.info("EGSNotifier: Notifying EGS that it's not "+gaming_id+"'s turn");
        return me.buildUpdate({gamingId: gaming_id, state: me.STATES.PEND});
      }
  );
  logger.info("EGSNotifier: Notifying EGS that it's "+this.players[role]+"'s turn");
  updates.push(this.buildUpdate({gamingId: this.players[role], state: this.STATES.ATTN}));
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.validateRole = function(role) {
  if (!this.players[role]) {
    throw "Invalid role: " + role;
  }
};

EGSNotifier.prototype.validateState = function(state) {
  if (!_.find(this.STATES, function(s) { return s === state; })) {
    throw "Invalid state: '" + state +"'. Must be one of the values in EGSNotifier.STATES.";
  }
};

/*
 * Sets the waiting state for each role specified in `state`.
 * `state` is an object which has roles for properties and their attention
 * state for values. Valid values are "ATTENTION" and "PENDING".
 *
 * "ATTENTION" indicates that the game is waiting for this player to
 * provide input (for example, to take their turn). "PENDING" means that
 * the game is not waiting on this player (for example, it is the other
 * player's turn).
 *
 * Example state:
 * {
 *   white: "ATTENTION",
 *   black: "PENDING"
 * }
 */
EGSNotifier.prototype.setPlayerState = function(states) {
  var role, state;
  var updates = [];

  for (role in states) {
    if (states.hasOwnProperty(role)) {
      state = states[role];
      this.validateRole(role);
      this.validateState(state);
      updates.push(this.buildUpdate({gamingId: this.players[role], state: state}));
    }
  }

  if (updates.length === 0) {
    return;
  }
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.forfeit = function(forfeiting_role) {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that "+forfeiting_role+" has forfeited and the game is over.");
  var updates = _.map(this.players, function(gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      score: 0
    }
    if (gaming_id === me.players[forfeiting_role]) {
      options.outcome = "Forfeit";
    } else {
      options.outcome = "Win";
    }

    return me.buildUpdate(options);
  });
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.draw = function() {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that the game is a draw.");
  var updates = _.map(this.players, function(gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      outcome: "Draw"
    }
    return me.buildUpdate(options);
  });
  return this.deliver({ update: updates });
};

EGSNotifier.prototype.gameover = function(winning_role, scores) {
  var me = this;
  logger.info("EGSNotifier: Notifying EGS that it's gameover.");

  var scores_with_ids = {};
  _.each(scores, function(score, role) {
    scores_with_ids[me.players[role]] = score;
  });

  var updates = _.map(this.players, function(gaming_id, role) {
    var options = {
      gamingId: gaming_id,
      state: me.STATES.OVER,
      score: scores[role]
    }
    if (gaming_id === me.players[winning_role]) {
      options.outcome = "Win";
    } else {
      options.outcome = "Lose";
    }
    return me.buildUpdate(options);
  });

  return this.deliver({ update: updates });
};

exports.EGSNotifier = EGSNotifier;

