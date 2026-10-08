# Benchmark

What `npm run bench` measured on `@sveltekit-i18n/sv` 1.0.0, written by the release that published it. A pull request compares its branch with its base in a comment; this file keeps the figures of each release beside its code.

Node v24.21.0, linux x64; `sv` 1.1.1 and `@sveltejs/sv-utils` 1.0.2. A time is the first call in a process of its own, as `sv` makes it, and the median of 11 processes; a spread leaves out the lowest and the highest quarter of them, rounded down.

## Sizes

Bytes of the bundle `sv` imports and of the tarball it downloads: the same on every machine.

| Row | Value |
| --- | ---: |
| dist/index.js, minified | 781,078 B |
| the tarball sv downloads, gzipped | 211,725 B |

## Times

Milliseconds, of one machine at one time: compare them only with figures measured beside them.

| Row | Median | Spread |
| --- | ---: | --- |
| import the add-on, sv loaded | 28.5 ms | 27.9 ms to 29.1 ms |
| run(), TypeScript, default options | 49.4 ms | 47.9 ms to 127 ms |
| run(), JavaScript, every option | 56.7 ms | 53.5 ms to 57.2 ms |
| run(), a project with its own hooks, layout loads and params | 61.1 ms | 59.9 ms to 63.5 ms |
| run(), the same with 2,000 lines in each of those | 214 ms | 212 ms to 216 ms |
