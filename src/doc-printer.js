"use strict";

const docBuilders = require("./doc-builders");
const concat = docBuilders.concat;
const line = docBuilders.line;
const softline = docBuilders.softline;
const fill = docBuilders.fill;
const ifBreak = docBuilders.ifBreak;

const MODE_BREAK = 1;
const MODE_FLAT = 2;

function rootIndent() {
  return {
    indent: 0,
    align: {
      spaces: 0,
      tabs: 0
    }
  };
}

function makeIndent(ind) {
  return {
    indent: ind.indent + 1,
    align: ind.align
  };
}

function makeAlign(ind, n) {
  if (n === -Infinity) {
    return {
      indent: 0,
      align: {
        spaces: 0,
        tabs: 0
      }
    };
  }

  return {
    indent: ind.indent,
    align: {
      spaces: ind.align.spaces + n,
      tabs: ind.align.tabs + (n ? 1 : 0)
    }
  };
}

function fits(next, restCommands, width, mustBeFlat) {
  let restIdx = restCommands.length;
  const cmds = [next];
  while (width >= 0) {
    if (cmds.length === 0) {
      if (restIdx === 0) {
        return true;
      } else {
        cmds.push(restCommands[restIdx - 1]);

        restIdx--;

        continue;
      }
    }

    const x = cmds.pop();
    const ind = x[0];
    const mode = x[1];
    const doc = x[2];
    const align = x[3];

    if (typeof doc === "string") {
      width -= doc.length;
    } else {
      switch (doc.type) {
        case "concat":
          for (var i = doc.parts.length - 1; i >= 0; i--) {
            cmds.push([ind, mode, doc.parts[i], align]);
          }

          break;
        case "indent":
          cmds.push([makeIndent(ind), mode, doc.contents]);

          break;
        case "align":
          cmds.push([makeAlign(ind, doc.n), mode, doc.contents]);

          break;
        case "group":
          if (mustBeFlat && doc.break) {
            return false;
          }
          cmds.push([ind, doc.break ? MODE_BREAK : mode, doc.contents]);

          break;
        case "fill":
          for (var i = doc.parts.length - 1; i >= 0; i--) {
            cmds.push([ind, mode, doc.parts[i]]);
          }

          break;
        case "if-break":
          if (mode === MODE_BREAK) {
            if (doc.breakContents) {
              cmds.push([ind, mode, doc.breakContents, align]);
            }
          }
          if (mode === MODE_FLAT) {
            if (doc.flatContents) {
              cmds.push([ind, mode, doc.flatContents, align]);
            }
          }

          break;
        case "line":
          switch (mode) {
            // fallthrough
            case MODE_FLAT:
              if (!doc.hard) {
                if (!doc.soft) {
                  width -= 1;
                }

                break;
              }

            case MODE_BREAK:
              return true;
          }
          break;
      }
    }
  }
  return false;
}

function printDocToString(doc, options) {
  let width = options.printWidth;
  let newLine = options.newLine || "\n";
  let pos = 0;
  // cmds is basically a stack. We've turned a recursive call into a
  // while loop which is much faster. The while loop below adds new
  // cmds to the array instead of recursively calling `print`.
  let cmds = [[rootIndent(), MODE_BREAK, doc]];
  let out = [];
  let shouldRemeasure = false;
  let lineSuffix = [];

  while (cmds.length !== 0) {
    const x = cmds.pop();
    const ind = x[0];
    const mode = x[1];
    const doc = x[2];
    const align = x[3];

    if (typeof doc === "string") {
      out.push(doc);

      pos += doc.length;
    } else {
      switch (doc.type) {
        case "concat":
          for (var i = doc.parts.length - 1; i >= 0; i--) {
            cmds.push([ind, mode, doc.parts[i], align]);
          }

          break;
        case "indent":
          cmds.push([makeIndent(ind), mode, doc.contents]);

          break;
        case "align":
          cmds.push([makeAlign(ind, doc.n), mode, doc.contents]);

          break;
        case "group":
          switch (mode) {
            // fallthrough
            case MODE_FLAT:
              if (!shouldRemeasure) {
                cmds.push([
                  ind,
                  doc.break ? MODE_BREAK : MODE_FLAT,
                  doc.contents,
                  align
                ]);

                break;
              }

            case MODE_BREAK:
              shouldRemeasure = false;

              const next = [ind, MODE_FLAT, doc.contents, align];
              let rem = width - pos;

              if (!doc.break && fits(next, cmds, rem)) {
                cmds.push(next);
              } else {
                // Expanded states are a rare case where a document
                // can manually provide multiple representations of
                // itself. It provides an array of documents
                // going from the least expanded (most flattened)
                // representation first to the most expanded. If a
                // group has these, we need to manually go through
                // these states and find the first one that fits.
                if (doc.expandedStates) {
                  const mostExpanded =
                    doc.expandedStates[doc.expandedStates.length - 1];

                  if (doc.break) {
                    cmds.push([ind, MODE_BREAK, mostExpanded, align]);

                    break;
                  } else {
                    for (var i = 1; i < doc.expandedStates.length + 1; i++) {
                      if (i >= doc.expandedStates.length) {
                        cmds.push([ind, MODE_BREAK, mostExpanded, align]);

                        break;
                      } else {
                        const state = doc.expandedStates[i];
                        const cmd = [ind, MODE_FLAT, state, align];

                        if (fits(cmd, cmds, rem)) {
                          cmds.push(cmd);

                          break;
                        }
                      }
                    }
                  }
                } else {
                  cmds.push([ind, MODE_BREAK, doc.contents, align]);
                }
              }

              break;
          }
          break;

        // Fills each line with as much code as possible before moving to a new
        // line with the same indentation.
        //
        // Expects doc.parts to be an array of alternating content and
        // whitespace. The whitespace contains the linebreaks.
        //
        // For example:
        //   ["I", line, "love", line, "monkeys"]
        // or
        //   [{ type: group, ... }, softline, { type: group, ... }]
        //
        // It uses this parts structure to handle three main layout cases:
        // * The first two content items fit on the same line without
        //   breaking
        //   -> output the first content item and the whitespace "flat".
        // * Only the first content item fits on the line without breaking
        //   -> output the first content item "flat" and the whitespace with
        //   "break".
        // * Neither content item fits on the line without breaking
        //   -> output the first content item and the whitespace with "break".
        case "fill": {
          let rem = width - pos;

          const parts = doc.parts;
          if (parts.length === 0) {
            break;
          }

          const content = parts[0];
          const contentFlatCmd = [ind, MODE_FLAT, content];
          const contentBreakCmd = [ind, MODE_BREAK, content];
          const contentFits = fits(contentFlatCmd, [], width - rem, true)

          if (parts.length === 1) {
            if (contentFits) {
              cmds.push(contentFlatCmd);
            } else {
              cmds.push(contentBreakCmd);
            }
            break;
          }

          const whitespace = parts[1];
          const whitespaceFlatCmd = [ind, MODE_FLAT, whitespace]
          const whitespaceBreakCmd = [ind, MODE_BREAK, whitespace]

          if (parts.length === 2) {
            if (contentFits) {
              cmds.push(whitespaceFlatCmd);
              cmds.push(contentFlatCmd);
            } else {
              cmds.push(whitespaceBreakCmd);
              cmds.push(contentBreakCmd);
            }
            break;
          }

          const remaining = parts.slice(2);
          const remainingCmd = [ind, mode, fill(remaining)];

          const secondContent = parts[2];
          const firstAndSecondContentFlatCmd = [ind, MODE_FLAT, concat([content, whitespace, secondContent])];
          const firstAndSecondContentFits = fits(firstAndSecondContentFlatCmd, [], rem, true);

          if (firstAndSecondContentFits) {
            cmds.push(remainingCmd)
            cmds.push(whitespaceFlatCmd);
            cmds.push(contentFlatCmd);
          } else if (contentFits) {
            cmds.push(remainingCmd)
            cmds.push(whitespaceBreakCmd);
            cmds.push(contentFlatCmd);
          } else {
            cmds.push(remainingCmd);
            cmds.push(whitespaceBreakCmd);
            cmds.push(contentBreakCmd);
          }
          break;
        }
        case "if-break":
          if (mode === MODE_BREAK) {
            if (doc.breakContents) {
              cmds.push([ind, mode, doc.breakContents, align]);
            }
          }
          if (mode === MODE_FLAT) {
            if (doc.flatContents) {
              cmds.push([ind, mode, doc.flatContents, align]);
            }
          }

          break;
        case "line-suffix":
          lineSuffix.push([ind, mode, doc.contents, align]);
          break;
        case "line-suffix-boundary":
          if (lineSuffix.length > 0) {
            cmds.push([ind, mode, { type: "line", hard: true }]);
          }
          break;
        case "line":
          switch (mode) {
            // fallthrough
            case MODE_FLAT:
              if (!doc.hard) {
                if (!doc.soft) {
                  out.push(" ");

                  pos += 1;
                }

                break;
              } else {
                // This line was forced into the output even if we
                // were in flattened mode, so we need to tell the next
                // group that no matter what, it needs to remeasure
                // because the previous measurement didn't accurately
                // capture the entire expression (this is necessary
                // for nested groups)
                shouldRemeasure = true;
              }

            case MODE_BREAK:
              if (lineSuffix.length) {
                cmds.push([ind, mode, doc, align]);
                [].push.apply(cmds, lineSuffix.reverse());
                lineSuffix = [];
                break;
              }

              if (doc.literal) {
                out.push(newLine);
                pos = 0;
              } else {
                if (out.length > 0) {
                  // Trim whitespace at the end of line
                  while (
                    out.length > 0 &&
                    out[out.length - 1].match(/^[^\S\n]*$/)
                  ) {
                    out.pop();
                  }

                  if (out.length) {
                    out[out.length - 1] = out[out.length - 1].replace(
                      /[^\S\n]*$/,
                      ""
                    );
                  }
                }

                let length = ind.indent * options.tabWidth + ind.align.spaces;
                let indentString = options.useTabs
                  ? "\t".repeat(ind.indent + ind.align.tabs)
                  : " ".repeat(length);
                out.push(newLine + indentString);
                pos = length;
              }
              break;
          }
          break;
        default:
      }
    }
  }
  return out.join("");
}

module.exports = { printDocToString };
