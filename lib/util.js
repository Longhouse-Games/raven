var inspect = function(obj, indent) {
  if (!indent) {
    indent = 1;
  }

  var string = "";
  for (var key in obj) {
    if (obj.hasOwnProperty(key)) {
      string += key.toString() + ":\n";
      for (var i = 0; i < indent; i++) {
        string += "  ";
      }
      var value = obj[key];
      if (typeof value === "object") {
        string += inspect(value, indent + 1);
      } else if (typeof value === "array") {
        string += "Array:\n" + key.toString();
        for (var i = 0; i < value.length; i++) {
          string += inspect(value[i], indent + 1);
        }
      } else {
        string += value.toString()+"\n";
      }
    }
  }
  return string;
};

exports.inspect = inspect;
