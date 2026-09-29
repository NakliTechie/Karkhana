// Host-only regression for the carried wasm32 POPCNT patch.
// Run: node qemu-build/test-cpu.mjs /path/to/qemu-wasm-checkout
// Or: QEMU_SOURCE_DIR=/path/to/qemu-wasm-checkout node --test qemu-build/test-cpu.mjs
// Requires git, python3, and a native C compiler (CC, default: cc).
// Reads the Dockerfile's pinned commit through git; never edits the checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const targetPath = 'tcg/wasm32/tcg-target.c.inc';
const sourceDirectory = process.env.QEMU_SOURCE_DIR || process.argv[2];
const builder = readFileSync(new URL('./Dockerfile.builder', import.meta.url), 'utf8');
const marker = '# Karkhana: wasm POPCNT operands and result type.';

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
}

function applyBuilderPatch(directory, original) {
  const markerOffset = builder.indexOf(marker);
  assert.ok(markerOffset >= 0, 'Dockerfile POPCNT patch marker is missing');
  assert.equal(builder.indexOf(marker, markerOffset + marker.length), -1, 'duplicate POPCNT patch marker');
  const afterMarker = builder.slice(markerOffset + marker.length);
  const heredoc = afterMarker.match(/^\s*(?:#[^\n]*\n\s*)*RUN python3 - <<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/);
  assert.ok(heredoc, 'marked patch must be a Python heredoc RUN instruction');
  const bodyStart = heredoc[0].length;
  const end = afterMarker.indexOf(`\n${heredoc[2]}\n`, bodyStart);
  assert.ok(end >= 0, 'unterminated POPCNT patch heredoc');
  let patch = afterMarker.slice(bodyStart, end);
  const input = join(directory, targetPath);
  mkdirSync(dirname(input), { recursive: true });
  writeFileSync(input, original);
  // Redirect only the input filename. All replacements and their guards execute
  // from the builder itself, so this test cannot silently test a different fix.
  const inputLiteral = /(['"])(?:\/qemu\/)?tcg\/wasm32\/tcg-target\.c\.inc\1/g;
  assert.equal([...patch.matchAll(inputLiteral)].length, 1, 'patch must name exactly one target file');
  patch = patch.replace(inputLiteral, JSON.stringify(input));
  command('python3', ['-c', patch], { cwd: directory });
  return readFileSync(input, 'utf8');
}

// Balance braces while ignoring comments and literals. A missing or changed
// function fails extraction instead of falling back to a copied implementation.
function functionSource(source, name) {
  const declaration = new RegExp(`^static(?: inline)? void ${name}\\s*\\(`, 'm').exec(source);
  assert.ok(declaration, `missing C function ${name}`);
  const opening = source.indexOf('{', declaration.index);
  let depth = 0, state = 'code';
  for (let index = opening; index < source.length; index++) {
    const character = source[index], next = source[index + 1];
    if (state === 'line') {
      if (character === '\n') state = 'code';
    } else if (state === 'block') {
      if (character === '*' && next === '/') { state = 'code'; index++; }
    } else if (state === '"' || state === "'") {
      if (character === '\\') index++;
      else if (character === state) state = 'code';
    } else if (character === '/' && next === '/') {
      state = 'line'; index++;
    } else if (character === '/' && next === '*') {
      state = 'block'; index++;
    } else if (character === '"' || character === "'") {
      state = character;
    } else if (character === '{') {
      depth++;
    } else if (character === '}' && --depth === 0) {
      return source.slice(declaration.index, index + 1);
    }
  }
  assert.fail(`unterminated C function ${name}`);
}

function compileEmitter(directory, name, source) {
  const registerMap = source.match(/static const uint8_t tcg_target_reg_index\[TCG_TARGET_NB_REGS\]\s*=\s*\{[^}]*\};/);
  assert.ok(registerMap, 'missing actual TCG register map');
  const dispatcher = functionSource(source, 'tcg_out_op');
  const cases = [32, 64].map(bits => {
    const match = dispatcher.match(new RegExp(`case INDEX_op_ctpop_i${bits}:([\\s\\S]*?)\\bbreak;`));
    assert.ok(match, `missing ctpop_i${bits} dispatch case`);
    return match[0];
  });
  const functions = [
    'tcg_wasm_out8', 'tcg_wasm_out_op_var',
    'tcg_wasm_out_op_global_get', 'tcg_wasm_out_op_global_set',
    'tcg_wasm_out_op_global_get_r', 'tcg_wasm_out_op_global_set_r',
    'tcg_wasm_out_op_i32_wrap_i64', 'tcg_wasm_out_op_i32_popcnt',
    'tcg_wasm_out_op_i64_popcnt', 'tcg_wasm_out_op_i64_extend_i32_u',
    'tcg_wasm_out_ctpop_i32', 'tcg_wasm_out_ctpop_i64',
    'tcg_tci_out_op_rr', 'tcg_out_ctpop_i32', 'tcg_out_ctpop_i64',
  ].map(functionName => functionSource(source, functionName));
  const program = `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#define TCG_TARGET_NB_REGS 16
#define TCG_REG_R14 14
typedef int TCGReg;
typedef int TCGOpcode;
typedef uintptr_t TCGArg;
enum { INDEX_op_ctpop_i32 = 32, INDEX_op_ctpop_i64 = 64 };
typedef struct {
    uint8_t bytes[128];
    size_t size;
    uint32_t tci;
    unsigned tci_count;
} TCGContext;
static bool env_cached;
static void tcg_sub_out8(TCGContext *s, uint32_t byte) {
    assert(s->size < sizeof(s->bytes));
    s->bytes[s->size++] = byte;
}
static uint32_t deposit32(uint32_t original, unsigned start, unsigned length, uint32_t value) {
    uint32_t mask = ((UINT32_C(1) << length) - 1) << start;
    return (original & ~mask) | ((value << start) & mask);
}
static void tcg_tci_out32(TCGContext *s, uint32_t instruction) {
    s->tci = instruction;
    s->tci_count++;
}
${registerMap[0]}
${functions.join('\n\n')}
static void dispatch(TCGContext *s, TCGOpcode opc, const TCGArg *args) {
    switch (opc) {
    ${cases.join('\n')}
    default: assert(false);
    }
}
int main(void) {
    const unsigned pairs[][2] = {{0, 1}, {1, 0}, {3, 3}, {15, 8}, {14, 5}};
    for (unsigned mode = 0; mode < 2; mode++) {
        for (unsigned bits = 32; bits <= 64; bits += 32) {
            for (unsigned pair = 0; pair < sizeof(pairs) / sizeof(pairs[0]); pair++) {
                TCGContext context = {0};
                // args[2] is deliberately valid but unrelated. Reading it is
                // a deterministic wrong-operand failure, never undefined C.
                const TCGArg args[] = {pairs[pair][0], pairs[pair][1], 13};
                if (mode) dispatch(&context, bits, args);
                else if (bits == 32) tcg_wasm_out_ctpop_i32(&context, args[0], args[1]);
                else tcg_wasm_out_ctpop_i64(&context, args[0], args[1]);
                printf("{\\"dispatch\\":%u,\\"bits\\":%u,\\"dest\\":%u,\\"src\\":%u,\\"tci\\":%u,\\"tciCount\\":%u,\\"hex\\":\\"",
                    mode, bits, pairs[pair][0], pairs[pair][1], context.tci, context.tci_count);
                for (size_t i = 0; i < context.size; i++) printf("%02x", context.bytes[i]);
                puts("\\"}");
            }
        }
    }
    return 0;
}
`;
  const cPath = join(directory, `${name}.c`), binary = join(directory, name);
  writeFileSync(cPath, program);
  command(process.env.CC || 'cc', ['-std=c99', '-O2', '-Wall', '-Wextra', '-Werror',
    '-Wno-unused-function', cPath, '-o', binary]);
  return command(binary, []).trim().split('\n').map(line => JSON.parse(line));
}

function uleb(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

function wasmString(value) {
  const bytes = [...Buffer.from(value)];
  return [...uleb(bytes.length), ...bytes];
}

function section(id, bytes) { return [id, ...uleb(bytes.length), ...bytes]; }

function moduleBytes(emission) {
  const imports = [];
  for (let index = 0; index < 16; index++) {
    imports.push(...wasmString('regs'), ...wasmString(`r${index}`), 3, 0x7e, 1);
  }
  const body = [0, ...Buffer.from(emission.hex, 'hex'), 0x0b];
  return Uint8Array.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]), // () -> (), one function type
    ...section(2, [16, ...imports]), // mutable i64 globals, like QEMU's registers
    ...section(3, [1, 0]),
    ...section(7, [1, ...wasmString('run'), 0, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

function instantiate(emission) {
  const registers = Array.from({ length: 16 }, () => new WebAssembly.Global({ value: 'i64', mutable: true }, 0n));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(emission)), {
    regs: Object.fromEntries(registers.map((register, index) => [`r${index}`, register])),
  });
  return { registers, run: instance.exports.run };
}

function popcount(value, bits) {
  let remaining = BigInt.asUintN(bits, value), count = 0n;
  while (remaining) { remaining &= remaining - 1n; count++; }
  return count;
}

function vectors() {
  const values = [0n, 1n, -1n, 0x7fffffffn, 0x80000000n, 0xffffffffn,
    0x100000000n, 0xffffffff00000000n, 0x8000000000000000n,
    0xaaaaaaaaaaaaaaaan, 0x5555555555555555n, 0x123456789abcdef0n];
  for (let bit = 0n; bit < 64n; bit++) values.push(1n << bit, ~(1n << bit));
  let state = 0x8d4c91b3e720fa65n;
  for (let index = 0; index < 128; index++) {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    values.push(state);
  }
  return values;
}

function checkValues(emission, inputs) {
  const { registers, run } = instantiate(emission);
  for (const input of inputs) {
    const before = registers.map((register, index) => {
      const value = BigInt.asIntN(64, index === emission.src ? input : 0x123400n + BigInt(index));
      register.value = value;
      return value;
    });
    run();
    for (let index = 0; index < registers.length; index++) {
      const expected = index === emission.dest ? popcount(input, emission.bits) : before[index];
      assert.equal(registers[index].value, expected,
        `i${emission.bits}, dispatch=${emission.dispatch}, dest=${emission.dest}, src=${emission.src}, input=${input}, register=${index}`);
    }
  }
}

test('builder POPCNT patch emits valid Wasm and preserves unary operands', async t => {
  assert.ok(sourceDirectory, 'pass a QEMU git checkout path or set QEMU_SOURCE_DIR');
  const pin = builder.match(/^ARG QEMU_REPO_VERSION=([0-9a-f]{40})\s*$/m)?.[1];
  assert.ok(pin, 'Dockerfile must pin a full QEMU commit');
  const checkout = resolve(sourceDirectory);
  const original = command('git', ['-C', checkout, 'show', `${pin}:${targetPath}`]);
  const directory = mkdtempSync(join(tmpdir(), 'karkhana-cpu-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const patched = applyBuilderPatch(directory, original);
  const baseline = compileEmitter(directory, 'original-emitter', original);
  const fixed = compileEmitter(directory, 'patched-emitter', patched);
  const inputs = vectors();

  await t.test('original i32 emitter fails Wasm validation without widening', () => {
    const emission = baseline.find(row => !row.dispatch && row.bits === 32);
    assert.equal(WebAssembly.validate(moduleBytes(emission)), false);
    assert.throws(() => instantiate(emission), WebAssembly.CompileError);
  });

  await t.test('original dispatcher selects the wrong input and output for both widths', () => {
    for (const emission of baseline.filter(row => row.dispatch)) {
      assert.equal(emission.tciCount, 1);
      assert.equal((emission.tci >>> 8) & 15, emission.src);
      assert.equal((emission.tci >>> 12) & 15, 13);
    }
    const emission = baseline.find(row => row.dispatch && row.bits === 64);
    assert.throws(() => checkValues(emission, [0xffffffffn]), assert.AssertionError);
  });

  await t.test('original i64 emitter passes the same numeric oracle', () => {
    for (const emission of baseline.filter(row => !row.dispatch && row.bits === 64)) {
      checkValues(emission, inputs);
    }
  });

  for (const bits of [32, 64]) {
    await t.test(`patched i${bits} emitter handles boundary and deterministic random values`, () => {
      for (const emission of fixed.filter(row => !row.dispatch && row.bits === bits)) {
        assert.equal(WebAssembly.validate(moduleBytes(emission)), true);
        checkValues(emission, inputs);
      }
    });
    await t.test(`patched i${bits} dispatch updates only the destination, including aliased registers`, () => {
      for (const emission of fixed.filter(row => row.dispatch && row.bits === bits)) {
        assert.equal(emission.tciCount, 1);
        assert.equal(emission.tci & 255, bits);
        assert.equal((emission.tci >>> 8) & 15, emission.dest);
        assert.equal((emission.tci >>> 12) & 15, emission.src);
        checkValues(emission, inputs);
      }
    });
  }
  t.diagnostic(`QEMU ${pin}; ${inputs.length} inputs per emitter/register pair; native cc and Node WebAssembly only`);
});
