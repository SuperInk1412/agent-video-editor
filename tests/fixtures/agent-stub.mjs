const task = process.argv.at(-1);
console.log(JSON.stringify({ type: 'final', text: JSON.stringify({ note: 'test', ops: [{ op: 'setMeta', path: 'title', value: 'proposal' }] }) }));
if (task.endsWith('review:hang')) setInterval(() => {}, 1000);
else if (task.endsWith('review:fail')) process.exitCode = 1;
