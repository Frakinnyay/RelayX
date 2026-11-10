import { DELIVERY_STATUSES, assertTransition, canTransition, isTerminal, InvalidTransitionError } from '../../src/domain/state';

describe('delivery state machine', () => {
  it.each([
    ['PENDING', 'PROCESSING'],
    ['RETRY_WAITING', 'PROCESSING'],
    ['PROCESSING', 'SUCCESS'],
    ['PROCESSING', 'RETRY_WAITING'],
    ['PROCESSING', 'DEAD_LETTERED'],
    ['PROCESSING', 'PROCESSING'],
  ] as const)('allows %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(true));

  it.each([
    ['PENDING', 'SUCCESS'],
    ['PENDING', 'DEAD_LETTERED'],
    ['RETRY_WAITING', 'SUCCESS'],
    ['SUCCESS', 'PROCESSING'],
    ['SUCCESS', 'PENDING'],
    ['DEAD_LETTERED', 'PROCESSING'],
    ['DEAD_LETTERED', 'RETRY_WAITING'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('SUCCESS and DEAD_LETTERED are the only terminal states', () => {
    expect(DELIVERY_STATUSES.filter(isTerminal)).toEqual(['SUCCESS', 'DEAD_LETTERED']);
  });
});
