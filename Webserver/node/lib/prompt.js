'use strict';

// Console questions for the launchers. Works when typed and when answers are
// piped in (readline/promises drops piped lines that arrive early).

const readline = require('readline');

function createPrompter() {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(null);
  });

  return {
    async ask(question, fallback) {
      const hasFallback = fallback !== undefined && fallback !== null && String(fallback) !== '';
      rl.setPrompt(hasFallback ? `${question} [${fallback}]: ` : `${question}: `);
      rl.prompt();
      let line;
      if (lines.length > 0) line = lines.shift();
      else if (closed) line = null;
      else line = await new Promise((resolve) => waiters.push(resolve));
      if (line === null) throw new Error('no more input');
      if (!interactive) process.stdout.write(`${line}\n`);
      const answer = line.trim();
      return answer === '' && hasFallback ? String(fallback) : answer;
    },
    close() {
      rl.close();
    },
  };
}

module.exports = { createPrompter };
