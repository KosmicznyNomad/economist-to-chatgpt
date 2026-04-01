const assert = require('assert');

const originalChrome = global.chrome;
const RuntimeBridgeUi = require('./runtime-bridge-ui.js');

async function testSuccessfulEnvelope() {
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        callback({
          success: true,
          echoedType: payload.type
        });
      }
    }
  };

  const response = await RuntimeBridgeUi.sendMessage({ type: 'PING' });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.echoedType, 'PING');
  assert.deepStrictEqual(response.data, {
    success: true,
    echoedType: 'PING'
  });
}

async function testNoResponseIsNonThrowing() {
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_payload, callback) {
        this.lastError = { message: 'The message port closed before a response was received.' };
        callback(undefined);
        this.lastError = null;
      }
    }
  };

  const response = await RuntimeBridgeUi.sendMessage({ type: 'NO_RESPONSE' });
  assert.strictEqual(response.ok, true);
  assert.deepStrictEqual(response.data, {});
}

async function testUnavailableRuntimeErrorEnvelope() {
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_payload, callback) {
        this.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        callback(undefined);
        this.lastError = null;
      }
    }
  };

  const response = await RuntimeBridgeUi.sendMessage({ type: 'MISSING' });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.errorCode, 'runtime_unavailable');
}

async function main() {
  try {
    await testSuccessfulEnvelope();
    await testNoResponseIsNonThrowing();
    await testUnavailableRuntimeErrorEnvelope();
    console.log('test-runtime-bridge-ui.js passed');
  } finally {
    global.chrome = originalChrome;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
