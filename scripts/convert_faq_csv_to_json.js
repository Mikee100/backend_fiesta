const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Read the CSV file
const csv = fs.readFileSync('../knowledge_base_rows.csv');
const records = parse(csv, { columns: true });

// Write to JSON
fs.writeFileSync('knowledge_base_rows.json', JSON.stringify(records, null, 2));

console.log('Converted knowledge_base_rows.csv to knowledge_base_rows.json');
