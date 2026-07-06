import fs from 'fs';
import path from 'path';

const filePath = path.resolve(__dirname, '../Controllers/Delivery.controller.ts');
const fileContent = fs.readFileSync(filePath, 'utf8');
const lines = fileContent.split('\n');

for (let i = 151; i < 222; i++) {
    console.log(`[${i + 1}] ${lines[i]}`);
}
