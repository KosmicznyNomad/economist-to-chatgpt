const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function requiredIndexOf(needle) {
  const index = backgroundSource.indexOf(needle);
  assert(index >= 0, `Expected background.js to contain: ${needle}`);
  return index;
}

function testThinkingModeIsAttemptedBeforePromptChainWithoutStoppingRun() {
  const counterIndex = requiredIndexOf('const counter = createCounter();');
  const gateIndex = requiredIndexOf('const thinkingModeResult = await ensureThinkingModeBeforeRun(counter);');
  const attachIndex = backgroundSource.indexOf('if (!isResume) {', gateIndex);
  assert(gateIndex > counterIndex, 'Thinking gate must run immediately after counter creation.');
  assert(attachIndex > gateIndex, 'Thinking gate must run before payload/PDF/prompt work starts.');

  const failureBranchStart = requiredIndexOf('if (!thinkingModeResult?.success) {');
  const failureBranch = backgroundSource.slice(failureBranchStart, attachIndex);
  assert.match(failureBranch, /PROCESS_PROGRESS/);
  assert.match(failureBranch, /chat\.thinking_mode_unconfirmed/);
  assert.match(failureBranch, /needsAction:\s*false/);
  assert.strictEqual(
    failureBranch.includes('PROCESS_NEEDS_ACTION'),
    false,
    'Thinking setup failures must not require manual action.'
  );
  assert.strictEqual(
    failureBranch.includes('return {'),
    false,
    'Thinking setup failures must not stop before the prompt chain.'
  );

  assert.strictEqual(
    backgroundSource.includes('thinking_effort_warn'),
    false,
    'Thinking setup failures must not be downgraded to warnings.'
  );
  assert.strictEqual(
    backgroundSource.includes('nie ustawiono - zatrzymuje'),
    false,
    'Thinking setup failures must not use the old stopping status.'
  );
}

function testThinkingModeIsCheckedEvenWithoutRequestedEffort() {
  requiredIndexOf('async function ensureThinkingModeBeforeRun(counterRef = null)');
  requiredIndexOf('const maxAttempts = 3;');
  requiredIndexOf('for (let attempt = 1; attempt <= maxAttempts; attempt += 1)');
  requiredIndexOf("await ensureThinkingModeReadyForEffort(requestedComposerThinkingEffort || '', 9000)");
  requiredIndexOf('thinkingModeAttempt: attempt');
  requiredIndexOf("if (!requestedComposerThinkingEffort) {");
  requiredIndexOf("statusText: 'Thinking gotowy'");
}

function testGenericComposerPillDoesNotSatisfyThinkingMode() {
  requiredIndexOf('const hasThinkingSignal = hasThinkingContextToken(text) || isThinkingEffortMenuLabel(text);');
  requiredIndexOf('if (effort && !matchesThinkingEffortLabel(text, effort)) return -1;');
  requiredIndexOf('if (!effort && !hasThinkingSignal) return -1;');
  requiredIndexOf('return null;');
  assert.strictEqual(
    backgroundSource.includes('return effort ? (candidates[0] || null) : null;'),
    false,
    'Target effort detection must not fall back to the first composer pill, because that can be Instant.'
  );
}

function testInstantComposerPillCanOpenModelModeMenu() {
  requiredIndexOf('function isComposerModeSwitcherButton(button)');
  requiredIndexOf("if (isLikelyComposerButton(button) && !isComposerModeSwitcherButton(button)) return false;");
  requiredIndexOf('if (isComposerModeSwitcherButton(button)) score += 220;');
  requiredIndexOf('function isThinkingModeReadyInComposer()');
  requiredIndexOf('function getThinkingEffortPillButtons(targetEffort = \'\')');
  requiredIndexOf("if (effort === 'heavy') return ['heavy', 'intensive', 'intensywn', 'ciezki', 'ciężk'];");
  requiredIndexOf("normalizedText.includes('zaawansowan')");
  requiredIndexOf("console.log('[thinking-mode] selecting Thinking mode'");
}

function testAdvancedExtendedProPillCanOpenEffortMenu() {
  requiredIndexOf("'button'");
  requiredIndexOf("'[role=\"button\"]'");
  requiredIndexOf("'[tabindex=\"0\"]'");
  requiredIndexOf("'button[aria-haspopup=\"menu\"]'");
  requiredIndexOf('if (!hasThinkingContextToken(text) && !isThinkingEffortMenuLabel(text)) return false;');
  requiredIndexOf("containsWord(text, 'advanced')");
  requiredIndexOf("if (effort === 'extended') return ['extended', 'rozszerzon'];");
  requiredIndexOf("const isStrongThinkingEffortControl = text.includes('zaawansowan') && isThinkingEffortMenuLabel(text);");
  requiredIndexOf('return isStrongThinkingEffortControl || isComposerControl || hasMenuSignal;');
  requiredIndexOf('scoreThinkingEffortPillButton(button, effort)');
  requiredIndexOf('...getThinkingEffortPillButtons(effort)');
  requiredIndexOf('...getThinkingEffortPillButtons(\'\')');
  requiredIndexOf("[role=\"menuitem\"]");
  requiredIndexOf("labelNode.closest('[role=\"menuitemradio\"], [role=\"menuitem\"], button')");
  requiredIndexOf("console.log('[thinking-effort] opening effort menu from pill'");
  requiredIndexOf("console.log('[thinking-effort] selecting effort item'");
}

function main() {
  testThinkingModeIsAttemptedBeforePromptChainWithoutStoppingRun();
  testThinkingModeIsCheckedEvenWithoutRequestedEffort();
  testGenericComposerPillDoesNotSatisfyThinkingMode();
  testInstantComposerPillCanOpenModelModeMenu();
  testAdvancedExtendedProPillCanOpenEffortMenu();
  console.log('test-thinking-mode-before-run.js passed');
}

main();
