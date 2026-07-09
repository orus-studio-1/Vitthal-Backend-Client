import fs from 'fs';
import path from 'path';

const filePath = path.resolve(__dirname, '../Controllers/Delivery.controller.ts');
const fileContent = fs.readFileSync(filePath, 'utf8');
const lines = fileContent.split('\n');

lines.forEach((line, index) => {
    if (line.toLowerCase().includes('inbound')) {
        console.log(`Line ${index + 1}: ${line}`);
    }
});
