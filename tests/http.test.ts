import { describe, expect, it } from 'vitest';
import { bestRouteMatch, joinRoutePath, normalizePath, routeMatches } from '@flowslens/core';

describe('normalizePath', () => {
  it('strips the api prefix', () => {
    expect(normalizePath('/api/customers')).toBe('/customers');
    expect(normalizePath('/api/customers/')).toBe('/customers');
  });

  it('keeps paths that merely start with the prefix letters', () => {
    expect(normalizePath('/apiary/bees')).toBe('/apiary/bees');
  });

  it('drops query strings and fragments', () => {
    expect(normalizePath('/api/customers?search=jo&page=2')).toBe('/customers');
    expect(normalizePath('/api/customers#top')).toBe('/customers');
  });

  it('reduces dynamic segments to a single placeholder', () => {
    expect(normalizePath('/api/customers/<param>/notes')).toBe('/customers/:param/notes');
    expect(normalizePath('/api/customers/:id/notes')).toBe('/customers/:param/notes');
    expect(normalizePath('/api/customers/507f1f77bcf86cd799439011')).toBe('/customers/:param');
    expect(normalizePath('/api/customers/42')).toBe('/customers/:param');
  });

  it('handles absolute urls', () => {
    expect(normalizePath('https://shop.example.com/api/customers/7')).toBe('/customers/:param');
  });

  it('normalises a bare or empty path', () => {
    expect(normalizePath('/api')).toBe('/');
    expect(normalizePath('customers')).toBe('/customers');
  });

  it('honours a custom prefix list', () => {
    expect(normalizePath('/v1/customers', ['/v1'])).toBe('/customers');
    expect(normalizePath('/api/customers', [])).toBe('/api/customers');
  });
});

describe('joinRoutePath', () => {
  it('joins a controller prefix and a method suffix', () => {
    expect(joinRoutePath('customers', ':id/archive')).toBe('/customers/:param/archive');
    expect(joinRoutePath('customers', '')).toBe('/customers');
    expect(joinRoutePath('', 'health')).toBe('/health');
  });
});

describe('routeMatches', () => {
  it('matches on method and path', () => {
    expect(
      routeMatches({ method: 'POST', path: '/customers' }, { method: 'POST', path: '/customers' }),
    ).toBe(true);
  });

  it('rejects a method mismatch', () => {
    expect(
      routeMatches(
        { method: 'PUT', path: '/customers/:param' },
        { method: 'PATCH', path: '/customers/:param' },
      ),
    ).toBe(false);
  });

  it('treats :param as a wildcard segment', () => {
    expect(
      routeMatches(
        { method: 'GET', path: '/customers/:param' },
        { method: 'GET', path: '/customers/:param' },
      ),
    ).toBe(true);
    expect(
      routeMatches(
        { method: 'GET', path: '/customers/abc' },
        { method: 'GET', path: '/customers/:param' },
      ),
    ).toBe(true);
  });

  it('requires the same number of segments', () => {
    expect(
      routeMatches(
        { method: 'GET', path: '/customers/:param/notes' },
        { method: 'GET', path: '/customers/:param' },
      ),
    ).toBe(false);
  });
});

describe('bestRouteMatch', () => {
  const routes = [
    { id: 'a', method: 'GET', path: '/customers/:param' },
    { id: 'b', method: 'GET', path: '/customers/stats' },
  ];

  it('prefers the literal route over the parameterised one', () => {
    expect(bestRouteMatch({ method: 'GET', path: '/customers/stats' }, routes)?.id).toBe('b');
  });

  it('falls back to the parameterised route', () => {
    expect(bestRouteMatch({ method: 'GET', path: '/customers/:param' }, routes)?.id).toBe('a');
  });

  it('returns undefined when nothing matches', () => {
    expect(bestRouteMatch({ method: 'DELETE', path: '/customers/1' }, routes)).toBeUndefined();
  });
});
