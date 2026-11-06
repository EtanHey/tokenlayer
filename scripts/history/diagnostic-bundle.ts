import { sanitizeOutput } from '../../src/lib/egress';
const DIAGNOSTIC_TEXT = 8192, DIAGNOSTIC_NODES = 32, DIAGNOSTIC_DEPTH = 8, DIAGNOSTIC_MEMBERS = 16;
const UNAVAILABLE = '[diagnostic unavailable]'; // Constant: never interpolate a failing value here.
const diagnosticWrappers = new WeakMap<Error, string>();
// Diagnostic copies only: omit oversize raw text (never slice secrets), and do
// not invoke member iterators. Bounds cannot stop nonterminating user getters.
export function failureDetails(error: unknown): { text: string; failures: unknown[] } {
    const failures: unknown[] = [], seen = new Set<unknown>();
    let text = '', nodes = 0, clipped = false;
    const unavailable = (failure: unknown) => {
        failures.push(failure);
        // Stop user operations before they can produce unretainable exceptions.
        if (failures.length >= DIAGNOSTIC_NODES) clipped = true;
        if (text.length + UNAVAILABLE.length + 1 <= DIAGNOSTIC_TEXT)
            text += (text ? '\n' : '') + UNAVAILABLE;
    };
    const limit = () => unavailable(Error('history diagnostic limit'));
    const emit = (raw: unknown) => {
        if (typeof raw !== 'string') throw Error('history diagnostic non-text value');
        if (raw.length > DIAGNOSTIC_TEXT) { limit(); return; }
        const safe = sanitizeOutput(raw);
        if (text.length + safe.length + 1 > DIAGNOSTIC_TEXT - UNAVAILABLE.length - 1) {
            limit(); clipped = true; return;
        }
        text += (text ? '\n' : '') + safe;
    };
    const guard = (operation: () => void) => {
        if (clipped) return;
        try { operation(); } catch (failure) { unavailable(failure); }
    };
    const walk = (value: unknown, depth: number) => {
        if (clipped) return;
        if (nodes >= DIAGNOSTIC_NODES || depth > DIAGNOSTIC_DEPTH) { limit(); return; }
        if (seen.has(value)) { emit('[repeated error]'); return; }
        seen.add(value); nodes++;
        guard(() => emit(value instanceof Error
            ? diagnosticWrappers.get(value) ?? value.stack ?? value.message : String(value)));
        guard(() => {
            if (!(value instanceof AggregateError)) return;
            const members = value.errors;
            if (!Array.isArray(members)) throw Error('history diagnostic invalid members');
            const length = members.length;
            if (!Number.isSafeInteger(length) || length < 0) throw Error('history diagnostic invalid length');
            if (length > DIAGNOSTIC_MEMBERS) limit();
            for (let i = 0; i < Math.min(length, DIAGNOSTIC_MEMBERS) && !clipped; i++) {
                if (nodes >= DIAGNOSTIC_NODES) { limit(); break; }
                guard(() => walk(members[i], depth + 1));
            }
        });
        guard(() => {
            if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
                const cause = (value as Error).cause;
                if (cause !== undefined) walk(cause, depth + 1);
            }
        });
    };
    try { walk(error, 0); return { text, failures }; }
    catch (failure) {
        if (!clipped) unavailable(failure);
        return { text: UNAVAILABLE, failures };
    }
}
export function secondaryFailure(primary: unknown, stage: string, secondary: unknown): AggregateError {
    // Establish raw custody BEFORE touching any user-controlled error property.
    const combined = new AggregateError([primary, secondary], 'history primary failure', { cause: primary });
    const prefix = 'history primary failure; Secondary failure during ';
    const heading = typeof stage === 'string' && stage.length <= DIAGNOSTIC_TEXT - prefix.length
        ? prefix + stage : UNAVAILABLE;
    diagnosticWrappers.set(combined, heading); // Never re-expand rendered wrapper text.
    const diagnostic = failureDetails(combined);
    // Append raw references once. Rendering these now could generate more failures
    // recursively; later calls still obey the same traversal and retention caps.
    combined.errors.push(...diagnostic.failures);
    combined.message = combined.stack = diagnostic.text;
    return combined;
}
