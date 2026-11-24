import { describe, expect, it } from 'vitest';

import {
  type A2uiComponent,
  boundPointer,
  callFunction,
  checkMessages,
  isOneShot,
  overlayDrafts,
  pointerGet,
  pointerSet,
  resolvePath,
  resolveText,
  resolveValue,
  type Scope,
  templateChildren,
} from './a2ui-model';

type ChildRef = { componentId: string; scope: Scope };
type WireMessage = {
  updateComponents?: { components: A2uiComponent[] };
  updateDataModel?: { path?: string; value: unknown };
};

const expr = (inner: string): string => '$' + '{' + inner + '}';
const root = (model: unknown, index?: number): Scope => ({
  model,
  base: '',
  index,
});
const call = (
  name: string,
  args: Record<string, unknown>,
  scope: Scope = root({}),
): unknown => callFunction(name, args, scope);

function childRefs(component: A2uiComponent, scope: Scope): ChildRef[] {
  const single = [component.child, component.trigger, component.content]
    .filter((id): id is string => typeof id === 'string')
    .map((componentId) => ({ componentId, scope }));
  const tabs = Array.isArray(component.tabs)
    ? component.tabs.flatMap((tab: unknown) => {
        const child =
          typeof tab === 'object' && tab !== null && 'child' in tab
            ? tab.child
            : undefined;
        return typeof child === 'string' ? [{ componentId: child, scope }] : [];
      })
    : [];
  return [...templateChildren(component.children, scope), ...single, ...tabs];
}

function renderTexts(messages: WireMessage[]): string[] {
  let model: unknown = {};
  const components = new Map<string, A2uiComponent>();
  for (const message of messages) {
    if (message.updateDataModel) {
      model = pointerSet(
        model,
        message.updateDataModel.path ?? '/',
        message.updateDataModel.value,
      );
    }
    for (const component of message.updateComponents?.components ?? []) {
      components.set(component.id, component);
    }
  }
  const texts: string[] = [];
  const visit = (id: string, scope: Scope, depth: number): void => {
    const component = components.get(id);
    if (!component || depth > 32) {
      return;
    }
    if (component.component === 'Text') {
      texts.push(resolveText(component.text, scope));
    }
    for (const child of childRefs(component, scope)) {
      visit(child.componentId, child.scope, depth + 1);
    }
  };
  visit('root', { model, base: '' }, 0);
  return texts;
}

describe('pointerGet', () => {
  const doc = { a: { 'b/c': [10, { 'd~e': 'deep' }] } };

  it('returns the whole document for the root pointers', () => {
    expect(pointerGet(doc, '')).toBe(doc);
    expect(pointerGet(doc, '/')).toBe(doc);
  });

  it('reads object members and array items, decoding ~1 and ~0', () => {
    expect(pointerGet(doc, '/a/b~1c/1/d~0e')).toBe('deep');
    expect(pointerGet(doc, '/a/b~1c/0')).toBe(10);
  });

  it('returns undefined for a missing member, an out-of-range index, a non-canonical index or a pointer without a leading slash', () => {
    expect(pointerGet(doc, '/a/missing')).toBeUndefined();
    expect(pointerGet(doc, '/a/b~1c/5')).toBeUndefined();
    expect(pointerGet({ list: [1, 2] }, '/list/01')).toBeUndefined();
    expect(pointerGet(doc, 'a/b~1c')).toBeUndefined();
  });

  it('does not read inherited members', () => {
    expect(pointerGet(doc, '/a/constructor')).toBeUndefined();
  });
});

describe('pointerSet', () => {
  it('returns a new root, leaves the original untouched and shares the untouched branches', () => {
    const original = { user: { name: 'Ann' }, items: [1, 2] };
    const next = pointerSet(original, '/user/name', 'Bob') as typeof original;
    expect(next).toEqual({ user: { name: 'Bob' }, items: [1, 2] });
    expect(original.user.name).toBe('Ann');
    expect(next.items).toBe(original.items);
  });

  it('creates the missing objects along the path', () => {
    expect(pointerSet({}, '/a/b/c', 1)).toEqual({ a: { b: { c: 1 } } });
  });

  it('creates an array when the next segment is a numeric index', () => {
    expect(pointerSet({}, '/list/0/name', 'x')).toEqual({
      list: [{ name: 'x' }],
    });
  });

  it('deletes the key when the value is null or undefined', () => {
    expect(pointerSet({ a: 1, b: 2 }, '/a', null)).toEqual({ b: 2 });
    expect(pointerSet({ a: 1 }, '/a', undefined)).toEqual({});
  });

  it('returns the same root when deleting a path that is not there', () => {
    const model = { a: 1 };
    expect(pointerSet(model, '/x', null)).toBe(model);
    expect(pointerSet(model, '/x/y', null)).toBe(model);
  });

  it('removes an array element on null and appends with the - segment', () => {
    expect(pointerSet({ list: [1, 2, 3] }, '/list/1', null)).toEqual({
      list: [1, 3],
    });
    expect(pointerSet({ list: [1] }, '/list/-', 2)).toEqual({ list: [1, 2] });
  });

  it('ignores an array index past the end', () => {
    expect(pointerSet({ list: [1] }, '/list/5', 2)).toEqual({ list: [1] });
  });

  it('decodes ~1 in the set pointer and replaces the root for an empty pointer', () => {
    expect(pointerSet({}, '/a~1b', 1)).toEqual({ 'a/b': 1 });
    expect(pointerSet({ a: 1 }, '', { b: 2 })).toEqual({ b: 2 });
    expect(pointerSet({ a: 1 }, '/', null)).toBeUndefined();
  });
});

describe('resolvePath', () => {
  it('keeps an absolute path', () => {
    expect(resolvePath('/company', '/employees/0')).toBe('/company');
  });

  it('resolves a relative path against the base of a collection item', () => {
    expect(resolvePath('name', '/employees/1')).toBe('/employees/1/name');
  });

  it('resolves a relative path at the root scope and an empty path to the base', () => {
    expect(resolvePath('name', '')).toBe('/name');
    expect(resolvePath('', '/employees/1')).toBe('/employees/1');
  });
});

describe('overlayDrafts', () => {
  it('applies each draft pointer and deletes on null', () => {
    const model = { form: { email: 'a', phone: '1' } };
    expect(
      overlayDrafts(model, { '/form/email': 'b@x.io', '/form/phone': null }),
    ).toEqual({ form: { email: 'b@x.io' } });
    expect(model.form.email).toBe('a');
  });
});

describe('resolveValue', () => {
  it('returns literals unchanged', () => {
    expect(resolveValue('plain', root({}))).toBe('plain');
    expect(resolveValue(3, root({}))).toBe(3);
  });

  it('resolves an absolute binding whatever the base', () => {
    expect(
      resolveValue(
        { '@path': '/company' },
        { model: { company: 'Acme' }, base: '/employees/1' },
      ),
    ).toBe('Acme');
  });

  it('resolves a relative binding inside a template item scope', () => {
    const scope: Scope = {
      model: { employees: [{ name: 'Alice' }, { name: 'Bob' }] },
      base: '/employees/1',
      index: 1,
    };
    expect(resolveValue({ '@path': 'name' }, scope)).toBe('Bob');
  });

  it('resolves a nested function call before calling the outer one', () => {
    const value = {
      '@call': 'not',
      args: {
        value: { '@call': 'required', args: { value: { '@path': '/name' } } },
      },
    };
    expect(resolveValue(value, root({ name: '' }))).toBe(true);
    expect(resolveValue(value, root({ name: 'Ada' }))).toBe(false);
  });

  it('resolves bindings inside plain objects and arrays', () => {
    const value = {
      context: { id: { '@path': '/id' } },
      tags: ['a', { '@path': '/tag' }],
    };
    expect(resolveValue(value, root({ id: 7, tag: 'x' }))).toEqual({
      context: { id: 7 },
      tags: ['a', 'x'],
    });
  });
});

describe('resolveText', () => {
  it('turns null and undefined into an empty string and numbers and booleans into text', () => {
    expect(resolveText(null, root({}))).toBe('');
    expect(resolveText(undefined, root({}))).toBe('');
    expect(resolveText(42, root({}))).toBe('42');
    expect(resolveText(true, root({}))).toBe('true');
  });

  it('joins an array with ", " and stringifies an object as JSON', () => {
    expect(resolveText({ '@path': '/tags' }, root({ tags: ['a', 'b'] }))).toBe(
      'a, b',
    );
    expect(resolveText({ id: 1 }, root({}))).toBe('{"id":1}');
  });
});

describe('boundPointer', () => {
  it('returns the absolute pointer of a binding, relative to its base', () => {
    expect(
      boundPointer({ '@path': 'name' }, { model: {}, base: '/users/2' }),
    ).toBe('/users/2/name');
    expect(boundPointer({ '@path': '/draft/title' }, root({}))).toBe(
      '/draft/title',
    );
  });

  it('returns null for a literal and for a function call', () => {
    expect(boundPointer('literal', root({}))).toBeNull();
    expect(
      boundPointer({ '@call': 'required', args: { value: 'x' } }, root({})),
    ).toBeNull();
  });
});

describe('callFunction: required', () => {
  it('is false for null, undefined, an empty string and an empty array', () => {
    expect(call('required', { value: null })).toBe(false);
    expect(call('required', {})).toBe(false);
    expect(call('required', { value: '' })).toBe(false);
    expect(call('required', { value: [] })).toBe(false);
  });

  it('is true for zero, false and any text', () => {
    expect(call('required', { value: 0 })).toBe(true);
    expect(call('required', { value: false })).toBe(true);
    expect(call('required', { value: 'x' })).toBe(true);
  });
});

describe('callFunction: regex', () => {
  it('matches anywhere in the value, like RegExp.prototype.test', () => {
    expect(call('regex', { value: 'order 42 shipped', pattern: '\\d+' })).toBe(
      true,
    );
    expect(call('regex', { value: 'abc', pattern: '^\\d+$' })).toBe(false);
  });

  it('is false for a pattern that does not compile', () => {
    expect(call('regex', { value: 'abc', pattern: '(' })).toBe(false);
  });

  it('is false for a pattern longer than 512 characters and accepts one of exactly 512', () => {
    expect(
      call('regex', { value: 'a'.repeat(513), pattern: 'a'.repeat(513) }),
    ).toBe(false);
    expect(
      call('regex', { value: 'a'.repeat(512), pattern: 'a'.repeat(512) }),
    ).toBe(true);
  });

  it('is false for a value longer than 4096 code points and accepts one of exactly 4096', () => {
    expect(call('regex', { value: 'a'.repeat(4097), pattern: '^a+$' })).toBe(
      false,
    );
    expect(call('regex', { value: 'a'.repeat(4096), pattern: '^a+$' })).toBe(
      true,
    );
  });

  it('is false for a value that is neither text nor a number', () => {
    expect(call('regex', { value: { a: 1 }, pattern: '.' })).toBe(false);
  });
});

describe('callFunction: length', () => {
  it('counts code points, so an emoji is one character', () => {
    expect(call('length', { value: '😀', min: 1, max: 1 })).toBe(true);
    expect(call('length', { value: 'héllo', min: 5, max: 5 })).toBe(true);
  });

  it('enforces min and max', () => {
    expect(call('length', { value: 'abc', min: 4 })).toBe(false);
    expect(call('length', { value: 'abcdef', max: 5 })).toBe(false);
  });
});

describe('callFunction: numeric', () => {
  it('checks a number or a numeric string against min and max', () => {
    expect(call('numeric', { value: 5, min: 1, max: 10 })).toBe(true);
    expect(call('numeric', { value: '3.5', min: 3 })).toBe(true);
    expect(call('numeric', { value: '12', max: 10 })).toBe(false);
  });

  it('is false for an empty string or a non-number', () => {
    expect(call('numeric', { value: '' })).toBe(false);
    expect(call('numeric', { value: 'abc' })).toBe(false);
  });
});

describe('callFunction: email', () => {
  it('accepts an address with a domain and rejects one without', () => {
    expect(call('email', { value: 'ada@example.com' })).toBe(true);
    expect(call('email', { value: 'ada@example' })).toBe(false);
    expect(call('email', { value: 'a b@x.io' })).toBe(false);
  });
});

describe('callFunction: formatString', () => {
  it('interpolates an absolute path', () => {
    expect(
      call(
        'formatString',
        { value: 'Hi ' + expr('/user/name') + '!' },
        root({ user: { name: 'Ada' } }),
      ),
    ).toBe('Hi Ada!');
  });

  it('interpolates a relative path against the base of the template item', () => {
    const scope: Scope = {
      model: { items: [{ qty: 3 }] },
      base: '/items/0',
      index: 0,
    };
    expect(call('formatString', { value: expr('qty') + ' pcs' }, scope)).toBe(
      '3 pcs',
    );
  });

  it('interpolates a nested function call with a path argument', () => {
    const value =
      'Total: ' +
      expr('formatCurrency(value: ' + expr('/total') + ", currency: 'USD')");
    expect(call('formatString', { value }, root({ total: 1188 }))).toBe(
      'Total: $1,188.00',
    );
  });

  it('writes an escaped expression as literal text', () => {
    expect(
      call('formatString', { value: '\\' + expr('/x') }, root({ x: 1 })),
    ).toBe(expr('/x'));
  });

  it('keeps an unclosed expression as literal text', () => {
    expect(
      call('formatString', { value: 'Price ' + '$' + '{/x' }, root({})),
    ).toBe('Price ' + '$' + '{/x');
  });

  it('reads the item index through @index with an offset', () => {
    const scope: Scope = { model: {}, base: '/items/2', index: 2 };
    expect(
      call(
        'formatString',
        { value: expr('@index(offset: 1)') + '. item' },
        scope,
      ),
    ).toBe('3. item');
  });

  it('turns an unknown function inside an expression into nothing and reads literal arguments', () => {
    expect(
      call('formatString', { value: 'a' + expr('nope(value: 1)') + 'b' }),
    ).toBe('ab');
    expect(
      call('formatString', {
        value: expr("pluralize(value: 1, one: 'day', other: 'days')"),
      }),
    ).toBe('day');
  });
});

describe('callFunction: formatNumber', () => {
  it('groups thousands and keeps up to three fraction digits by default', () => {
    expect(call('formatNumber', { value: 1234567.891 })).toBe('1,234,567.891');
  });

  it('forces the decimals and turns grouping off on request', () => {
    expect(call('formatNumber', { value: 1234.5, decimals: 2 })).toBe(
      '1,234.50',
    );
    expect(call('formatNumber', { value: 1234, grouping: false })).toBe('1234');
  });

  it('is empty for a value that is not a number', () => {
    expect(call('formatNumber', { value: 'abc' })).toBe('');
  });
});

describe('callFunction: formatCurrency', () => {
  it('formats in the currency with its own digits', () => {
    expect(call('formatCurrency', { value: 199.99, currency: 'USD' })).toBe(
      '$199.99',
    );
    expect(call('formatCurrency', { value: 1188, currency: 'usd' })).toBe(
      '$1,188.00',
    );
  });

  it('applies decimals when given', () => {
    expect(
      call('formatCurrency', { value: 5, currency: 'EUR', decimals: 0 }),
    ).toBe('€5');
  });

  it('is empty for a code that is not three letters', () => {
    expect(call('formatCurrency', { value: 5, currency: 'EURO' })).toBe('');
  });
});

describe('callFunction: formatDate', () => {
  const noon = new Date(2026, 10, 24, 14, 5).getTime();

  it('formats a timestamp with the TR35 weekday, month and day fields', () => {
    expect(
      call('formatDate', { value: noon, format: 'EEEE, MMMM d, yyyy' }),
    ).toBe('Tuesday, November 24, 2026');
  });

  it('formats the 12-hour clock with the AM/PM marker', () => {
    expect(call('formatDate', { value: noon, format: 'h:mm a' })).toBe(
      '2:05 PM',
    );
  });

  it('writes a quoted literal as text', () => {
    expect(
      call('formatDate', { value: noon, format: "EEE, MMM d 'at' h:mm a" }),
    ).toBe('Tue, Nov 24 at 2:05 PM');
  });

  it('reads an ISO date-time without an offset as local time', () => {
    expect(
      call('formatDate', {
        value: '2026-11-24T14:05:00',
        format: 'dd.MM.yyyy',
      }),
    ).toBe('24.11.2026');
  });

  it('is empty for a value that is not a date', () => {
    expect(call('formatDate', { value: 'not a date', format: 'yyyy' })).toBe(
      '',
    );
    expect(call('formatDate', { value: {}, format: 'yyyy' })).toBe('');
  });
});

describe('callFunction: pluralize', () => {
  it('picks the one form for 1 and the other form for any other count', () => {
    expect(
      call('pluralize', { value: 1, one: 'review', other: 'reviews' }),
    ).toBe('review');
    expect(
      call('pluralize', { value: 0, one: 'review', other: 'reviews' }),
    ).toBe('reviews');
    expect(
      call('pluralize', { value: 2, one: 'review', other: 'reviews' }),
    ).toBe('reviews');
  });

  it('falls back to the other form when the one form is missing', () => {
    expect(call('pluralize', { value: 1, other: 'items' })).toBe('items');
  });
});

describe('callFunction: openUrl', () => {
  it('returns the action for an http or https address', () => {
    expect(call('openUrl', { url: 'https://example.com/docs' })).toEqual({
      kind: 'openUrl',
      url: 'https://example.com/docs',
    });
  });

  it('returns nothing for another scheme or a relative address', () => {
    expect(call('openUrl', { url: 'javascript:alert(1)' })).toBeUndefined();
    expect(call('openUrl', { url: 'data:text/html,hi' })).toBeUndefined();
    expect(call('openUrl', { url: '/relative/path' })).toBeUndefined();
  });
});

describe('callFunction: and, or, not', () => {
  it('reads each operand as a boolean, a validation result counting by its valid flag', () => {
    expect(call('and', { values: [true, { valid: true }] })).toBe(true);
    expect(call('and', { values: [true, { valid: false }] })).toBe(false);
    expect(call('and', { values: ['false', true] })).toBe(false);
  });

  it('is true for an empty and, and for or one operand is true', () => {
    expect(call('and', { values: [] })).toBe(true);
    expect(call('or', { values: [false, 'TRUE'] })).toBe(true);
    expect(call('or', { values: [false, 0] })).toBe(false);
  });

  it('negates the boolean value of its operand', () => {
    expect(call('not', { value: { valid: false } })).toBe(true);
    expect(call('not', { value: null })).toBe(true);
    expect(call('not', { value: 'hello' })).toBe(true);
  });
});

describe('callFunction: @index and unknown names', () => {
  it('adds the offset to the item index and is undefined outside a template', () => {
    expect(call('@index', {}, { model: {}, base: '/items/2', index: 2 })).toBe(
      2,
    );
    expect(
      call('@index', { offset: 1 }, { model: {}, base: '/items/2', index: 2 }),
    ).toBe(3);
    expect(call('@index', {}, root({}))).toBeUndefined();
  });

  it('returns undefined for a function name the catalog does not have', () => {
    expect(call('nope', {})).toBeUndefined();
  });
});

describe('checkMessages', () => {
  const component: A2uiComponent = {
    id: 'name_field',
    component: 'TextField',
    '@checks': [
      {
        condition: {
          '@call': 'required',
          args: { value: { '@path': '/name' } },
        },
        message: 'Name is required',
      },
      {
        condition: { '@call': 'email', args: { value: { '@path': '/email' } } },
      },
    ],
  };

  it('returns the message of each failing rule, with a fallback for a rule without one', () => {
    expect(checkMessages(component, root({ name: '', email: 'bad' }))).toEqual([
      'Name is required',
      'Invalid value',
    ]);
  });

  it('returns nothing when every rule passes', () => {
    expect(
      checkMessages(component, root({ name: 'Ada', email: 'ada@x.io' })),
    ).toEqual([]);
  });

  it('prefers the message of a validation result over the rule message', () => {
    const card: A2uiComponent = {
      id: 'card',
      component: 'TextField',
      '@checks': [{ condition: { '@path': '/result' }, message: 'fallback' }],
    };
    expect(
      checkMessages(
        card,
        root({ result: { valid: false, message: 'Card expired' } }),
      ),
    ).toEqual(['Card expired']);
    expect(checkMessages(card, root({ result: { valid: false } }))).toEqual([
      'fallback',
    ]);
  });
});

describe('templateChildren', () => {
  it('gives each id of a static list the same scope', () => {
    const scope = root({});
    expect(templateChildren(['a', 'b'], scope)).toEqual([
      { componentId: 'a', scope },
      { componentId: 'b', scope },
    ]);
  });

  it('gives each item of a template array its own absolute base and index', () => {
    const children = templateChildren(
      { componentId: 'item_row', path: '/items' },
      root({ items: [{ name: 'Apple' }, { name: 'Banana' }] }),
    );
    expect(
      children.map((child) => [
        child.componentId,
        child.scope.base,
        child.scope.index,
      ]),
    ).toEqual([
      ['item_row', '/items/0', 0],
      ['item_row', '/items/1', 1],
    ]);
  });

  it('gives each value of a template object its key as the base', () => {
    const children = templateChildren(
      { componentId: 'row', path: '/byId' },
      root({ byId: { a: {}, 'x/y': {} } }),
    );
    expect(children.map((child) => child.scope.base)).toEqual([
      '/byId/a',
      '/byId/x~1y',
    ]);
  });

  it('resolves a relative template path against the base of the enclosing item', () => {
    const scope: Scope = {
      model: { sections: [{}, { rows: ['x', 'y'] }] },
      base: '/sections/1',
    };
    expect(
      templateChildren({ componentId: 'row', path: 'rows' }, scope).map(
        (child) => child.scope.base,
      ),
    ).toEqual(['/sections/1/rows/0', '/sections/1/rows/1']);
  });

  it('is empty for a template over something that is not a collection', () => {
    expect(
      templateChildren({ componentId: 'row', path: '/missing' }, root({})),
    ).toEqual([]);
    expect(
      templateChildren(
        { componentId: 'row', path: '/title' },
        root({ title: 'x' }),
      ),
    ).toEqual([]);
  });
});

describe('isOneShot', () => {
  it('is true only when the geniroOneShot extension is true', () => {
    const button = (metadata: unknown): A2uiComponent => ({
      id: 'send',
      component: 'Button',
      '@metadata': metadata,
    });
    expect(isOneShot(button({ extensions: { geniroOneShot: true } }))).toBe(
      true,
    );
    expect(isOneShot(button({ extensions: { geniroOneShot: 'true' } }))).toBe(
      false,
    );
    expect(isOneShot(button({ extensions: { other: true } }))).toBe(false);
    expect(isOneShot({ id: 'send', component: 'Button' })).toBe(false);
  });
});

describe('the spec examples as surfaces', () => {
  it('renders the product card reviews, prices and their formatting', () => {
    const messages: WireMessage[] = [
      {
        updateDataModel: {
          value: {
            name: 'Wireless Headphones Pro',
            reviewCount: 2847,
            price: 199.99,
            originalPrice: 249.99,
          },
        },
      },
      {
        updateComponents: {
          components: [
            {
              id: 'root',
              component: 'Column',
              children: ['reviews', 'price', 'original_price'],
            },
            {
              id: 'reviews',
              component: 'Text',
              text: {
                '@call': 'formatString',
                args: {
                  value:
                    '(' +
                    expr('formatNumber(value: ' + expr('/reviewCount') + ')') +
                    ' ' +
                    expr(
                      'pluralize(value: ' +
                        expr('/reviewCount') +
                        ", one: 'review', other: 'reviews')",
                    ) +
                    ')',
                },
              },
            },
            {
              id: 'price',
              component: 'Text',
              text: {
                '@call': 'formatCurrency',
                args: { value: { '@path': '/price' }, currency: 'USD' },
              },
            },
            {
              id: 'original_price',
              component: 'Text',
              text: {
                '@call': 'formatCurrency',
                args: { value: { '@path': '/originalPrice' }, currency: 'USD' },
              },
            },
          ],
        },
      },
    ];
    expect(renderTexts(messages)).toEqual([
      '(2,847 reviews)',
      '$199.99',
      '$249.99',
    ]);
  });

  it('renders a list template whose rows read relative paths', () => {
    const messages: WireMessage[] = [
      {
        updateDataModel: {
          value: {
            items: [
              { name: 'Apple', quantity: 10 },
              { name: 'Banana', quantity: 5 },
            ],
          },
        },
      },
      {
        updateComponents: {
          components: [
            { id: 'root', component: 'Column', children: ['title', 'items'] },
            { id: 'title', component: 'Text', text: '### Dynamic Item List' },
            {
              id: 'items',
              component: 'List',
              children: { componentId: 'item_row', path: '/items' },
            },
            {
              id: 'item_row',
              component: 'Row',
              children: ['item_name', 'qty_label', 'item_qty'],
            },
            { id: 'item_name', component: 'Text', text: { '@path': 'name' } },
            { id: 'qty_label', component: 'Text', text: ' - Qty: ' },
            {
              id: 'item_qty',
              component: 'Text',
              text: { '@path': 'quantity' },
            },
          ],
        },
      },
    ];
    expect(renderTexts(messages)).toEqual([
      '### Dynamic Item List',
      'Apple',
      ' - Qty: ',
      '10',
      'Banana',
      ' - Qty: ',
      '5',
    ]);
  });

  it('renders a purchase total with a nested currency call and a suffix', () => {
    const messages: WireMessage[] = [
      { updateDataModel: { value: { total: 1188 } } },
      {
        updateComponents: {
          components: [
            { id: 'root', component: 'Column', children: ['total_value'] },
            {
              id: 'total_value',
              component: 'Text',
              text: {
                '@call': 'formatString',
                args: {
                  value:
                    expr(
                      'formatCurrency(value: ' +
                        expr('/total') +
                        ", currency: 'USD')",
                    ) + '/year',
                },
              },
            },
          ],
        },
      },
    ];
    expect(renderTexts(messages)).toEqual(['$1,188.00/year']);
  });
});
