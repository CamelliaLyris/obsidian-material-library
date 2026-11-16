// Updates the cloud section in the single-file Obsidian entry point.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'main.js');
const main = fs.readFileSync(file, 'utf8');
const start = main.indexOf('// Build source:');
const end = main.indexOf('module.exports = class MaterialLibraryPlugin', start);
if (start < 0 || end < start) throw new Error('Cloud bundle markers missing');
const cloud = fs.readFileSync(path.join(__dirname, 'cloud-source.js'), 'utf8');
fs.writeFileSync(file, main.slice(0, start) + cloud + '\n\n' + main.slice(end));
console.log('Cloud source bundled into main.js');
