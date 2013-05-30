inspect = require('util').inspect;

/*
 * Responsibilities:
 *  - set up new games with /new
 *    - validate /new params
 *    - generate response
 *    - prepare game to be played
 *    - notify EGS about initial player state
 *  - authenticate clients requesting /play
 *    - send client initial html file
 *    - set up websocket exchange
 *  - validate incoming websocket connections
 *    - pass messages from websocket to game
 *    - pass messages from game to websockets
 */
function init(game) {
  validate(game);

  process.title = "node " + game.metadata.slug;

  var me = this;

  this.configure = function(options) {
    me.options = options;
  };

  this.run = function() {
    me.init_server();
  };

  this.init_server = function() {
    var app = require('../app.js').init(game);
    app.configure(me.options);
    app.run();
  };

  return {
    configure: me.configure,
    run: me.run
  };
}

/*
 * Validate that the given game conforms to our specifications.
 * Throws an InvalidGameError if it doesn't.
 */
function validate(game) {
  var errors = {};
  if (!game) {
    throw "Game object must be provided";
  } else if (!game.metadata) {
    errors["metadata"] = ["Missing metadata."];
  } else {
    var e = [];
    if (!game.metadata.name) {
      e.push("Missing name.");
    }
    if (!game.metadata.slug) {
      e.push("Missing slug.");
    }
    if (!game.metadata.roles) {
      e.push("Missing roles.");
    }
    if (e.length > 0) {
      errors["metadata"] = e;
    }
  }
//   if (!game.create) {
//     errors["create"] = ["Missing create function."];
//   }
  for (var key in errors) {
    if (errors.hasOwnProperty(key)) {
      throw new InvalidGameError(errors);
    }
  }
  return;
}

var InvalidGameError = function(errors) {
  this.name = "InvalidGameError";
  this.message = "The given game is invalid. Errors:\n" + inspect(errors);
  this.errors = errors;
};
InvalidGameError.prototype = Object.create(Error);
InvalidGameError.prototype.constructor = InvalidGameError;

exports.init = init;
exports.InvalidGameError = InvalidGameError;
