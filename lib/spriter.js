var css = require('css'),
    fs = require('fs'),
    path = require('path'),
    mkdirp = require('mkdirp').sync,
    Canvas = require('canvas'),
Image = Canvas.Image,
    Packer = require('./packer');

exports = module.exports = spriter;

var urlPattern = /url\(['"]?((?:[^'"@)]+)(@[^\.]+)?[^'"]*)['"]?\)/;
var retinaQuery = '(-webkit-min-device-pixel-ratio: 1.5)';
var positionPattern = /\s*(?:no\-repeat|(\d+)(?:px)?\s+(\d+)(?:px)?)/g;
var retinaPattern = /(@\w+)\./;

var isRetinaRule = function(rule) {
    return rule.media && ~rule.media.indexOf(retinaQuery);
};

var groupByUrl = function(sheets, sprite) {
    (sheets[sprite.url] || (sheets[sprite.url] = [])).push(sprite);

    return sheets;
};

var findBackgrounds = function(rules, filter) {
    var visit = function(rules, backgrounds, media) {
        rules.forEach(function(rule) {
            if (rule.media) return visit(rule.rules, backgrounds, rule.media);

            rule.declarations && rule.declarations.forEach(function(declaration) {
                if ((declaration.property == 'background' || declaration.property == 'background-image')) {
                    var matches = urlPattern.exec(declaration.value);

                    if (matches) {
                        var url = matches[1];

                        if (!filter || ~url.indexOf(filter)) {
                            backgrounds.push({
                                rule: rule,
                                declaration: declaration,
                                url: url,
                                media: media
                            });
                        }
                    }
                }
            });
        });

        return backgrounds;
    };

    return visit(rules, []);
};

var groupBackgrounds = function(backgrounds, sheet) {
    return backgrounds.reduce(function(groups, background) {
        var matches = retinaPattern.exec(background.url);
        var name = sheet + (matches ? matches[1] : '');

        (groups[name] || (groups[name] = [])).push(background);

        return groups;
    }, {});
};

function series(callbacks, last) {
  var results = [];
  function next() {
    var callback = callbacks.shift();
    if(callback) {
      callback(function() {
        results.push(Array.prototype.slice.call(arguments));
        next();
      });
    } else {
      last(results);
    }
  }
  next();
}

function serialReduce(array, cb, initialValue, last) {
  var curLen = 0;
  var reduceCb = function (res) {
    if (curLen == array.length) {
      last(res);
    } else {
      curLen++;
      cb(reduceCb, res, array[curLen-1], curLen, array);
    }
  };

  reduceCb(initialValue);
}

function serialMap(array, cb, last) {
  var result = new Array(array.length);
  var curLen = 0;
  array.forEach(function (elt, idx) {
    var mapCb = function (elt) {
      result[idx] = elt;
      if (++curLen == array.length) {
        last(result);
      }
    };
    cb(mapCb, elt, idx);
  });
}

function serialForEach(array, cb, last) {
  var curLen = 0;
  array.forEach(function (elt, idx) {
    var eachCb = function (elt) {
      if (++curLen == array.length) {
        last();
      }
    };
    cb(eachCb, elt, idx, array);
  });
}

var createSpriteSheets = function(groups, sourcePath, targetPath, cb) {
    mkdirp(path.join(sourcePath, targetPath));

    var spriteMap = {};

  serialMap(
  Object.keys(groups),

  function(mapCb, name) {
    var backgrounds = groups[name];


    serialReduce(
      backgrounds,

    function (reduceCb, sprites, background) {
      var url = background.url;
      var sprite = spriteMap[url];
      var srcPath = path.join(sourcePath, url);

      if (!sprite) {
        var image = new Canvas.Image;
        image.onerror = function (err) {
          throw err;
        };
        image.onerror = function (err) {
          process.stderr.write("error loading " + srcPath + "\n");
          reduceCb(sprites);
        };
        image.onload = (function () {
          sprite = spriteMap[url] = {
            width: image.width,
            height: image.height,
            image: image,
            backgrounds: []
          };

          sprites.push(sprite);
          sprite.backgrounds.push(background);
          reduceCb(sprites);
        });
        image.src = srcPath;
      } else {
        sprite.backgrounds.push(background);
        reduceCb(sprites);
      }

    },

    [],

    function (sprites) {
      var packer = new Packer();
      var sheet = packer.pack(sprites);
      var canvas = new Canvas(sheet.width, sheet.height);
      var context = canvas.getContext('2d');
      var url = path.join(targetPath, name + '.png');
      sprites.forEach(function (sprite) {
        context.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height);
      });

      fs.writeFileSync(path.join(sourcePath, url), canvas.toBuffer());

      mapCb({
        url: url,
        width: sheet.width,
        height: sheet.height,
        sprites: sprites
      });
    });
  },

  cb);
};

var updateRules = function(sheets) {
    return sheets.reduce(function(rules, sheet) {
        sheet.sprites.forEach(function(sprite) {
            sprite.backgrounds.forEach(function(background) {
                var rule = background.rule;
                var pixelRatio = isRetinaRule(background) ? 2 : 1;
                var declarations = rule.declarations.reduce(function(declarations, declaration) {
                    declarations.push(declaration);

                    if (declaration == background.declaration) {
                        var position = (sprite.x ? -Math.round(sprite.x / pixelRatio) + 'px' : 0) + ' ' + (sprite.y ? -Math.round(sprite.y / pixelRatio) + 'px' : 0);

                        declaration.value = declaration.value.replace(urlPattern, 'url(' + sheet.url + ')');
                        declarations.push({property: 'background-position', value: position});
                    } else if (declaration.property == 'background-size') {
                        declaration.value = Math.round(sheet.width / pixelRatio) + 'px auto';
                    }

                    return declarations;
                }, []);

              declarations.push({property: "background-size",
                value: (sprite.x + sprite.width) + "px " + (sprite.y + sprite.height) + "px"
              });

                rule.declarations = declarations;

                rules.push(rule);
            });
        });

        return rules;
    }, []);
};

var optimizeRules = function(rules) {
    // Assemble in syntax order (https://developer.mozilla.org/en-US/docs/CSS/background#Syntax)
    var order = ['color', 'image', 'position', 'size', 'repeat', 'attachment', 'clip'];

    return rules.reduce(function(rules, rule) {
        var properties = {};

        var declarations = rule.declarations.filter(function(declaration) {
            if (declaration.property.indexOf('background') === 0) {
                properties[declaration.property.replace('background-', '')] = declaration.value;

                return false;
            }

            return true;
        });

        if (properties.background || (properties.image && properties.position)) {
            properties.repeat = 'no-repeat';

          var res = "";

            var values = Object.keys(properties).sort(function(a, b) {
                return order.indexOf(a) - order.indexOf(b);
            }).filter(function(property) {
                return properties[property] != '0 0';
            }).map(function(property) {
                var value = properties[property];

              var name = property;
              if (property !== "background") {
                name = "background-" + property;
              }
              properties[property] = (property == 'background') ? value.replace(positionPattern, '') : value;
              declarations = declarations.concat({
                property: name,
                value: properties[property]
              });
              return properties[property];
            });

            var declaration = {
                property: 'background',
                value: values.join(' ')
            };

          rule.declarations = declarations;
//          console.dir(declarations);

//            rule.declarations = declarations.concat(declaration);

            rules.push(rule);
        }

        return rules;
    }, []);
};

function spriter(str, sourcePath, targetPath, filter, optimize) {
  var ast = css.parse(str);

  var backgrounds = findBackgrounds(ast.stylesheet.rules, filter);
  var groups = groupBackgrounds(backgrounds, path.basename(targetPath, '.png'));
  createSpriteSheets(groups, sourcePath, path.dirname(targetPath), function (sheets) {
    var rules = updateRules(sheets);

    if (optimize) optimizeRules(rules);
    process.stdout.write(css.stringify(ast));
  });
}
