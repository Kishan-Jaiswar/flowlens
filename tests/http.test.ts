import { describe, expect, it } from 'vitest';
import { bestRouteMatch, joinRoutePath, normalizePath, routeMatches } from '@flowlens/core';

describe('normalizePath', () => {
  it('strips the api prefix', () => {
    expect(normalizePath('/api/patients')).toBe('/patients');
    expect(normalizePath('/api/patients/')).toBe('/patients');
  });

  it('keeps paths that merely start with the prefix letters', () => {
    expect(normalizePath('/apiary/bees')).toBe('/apiary/bees');
  });

  it('drops query strings and fragments', () => {
    expect(normalizePath('/api/patients?search=jo&page=2')).toBe('/patients');
    expect(normalizePath('/api/patients#top')).toBe('/patients');
  });

  it('reduces dynamic segments to a single placeholder', () => {
    expect(normalizePath('/api/patients/<param>/notes')).toBe('/patients/:param/notes');
    expect(normalizePath('/api/patients/:id/notes')).toBe('/patients/:param/notes');
    expect(normalizePath('/api/patients/507f1f77bcf86cd799439011')).toBe('/patients/:param');
    expect(normalizePath('/api/patients/42')).toBe('/patients/:param');
  });

  it('handles absolute urls', () => {
    expect(normalizePath('https://clinic.example.com/api/patients/7')).toBe('/patients/:param');
  });

  it('normalises a bare or empty path', () => {
    expect(normalizePath('/api')).toBe('/');
    expect(normalizePath('patients')).toBe('/patients');
  });

  it('honours a custom prefix list', () => {
    expect(normalizePath('/v1/patients', ['/v1'])).toBe('/patients');
    expect(normalizePath('/api/patients', [])).toBe('/api/patients');
  });
});

describe('joinRoutePath', () => {
  it('joins a controller prefix and a method suffix', () => {
    expect(joinRoutePath('patients', ':id/archive')).toBe('/patients/:param/archive');
    expect(joinRoutePath('patients', '')).toBe('/patients');
    expect(joinRoutePath('', 'health')).toBe('/health');
  });
});

describe('routeMatches', () => {
  it('matches on method and path', () => {
    expect(
      routeMatches({ method: 'POST', path: '/patients' }, { method: 'POST', path: '/patients' }),
    ).toBe(true);
  });

  it('rejects a method mismatch', () => {
    expect(
      routeMatches(
        { method: 'PUT', path: '/patients/:param' },
        { method: 'PATCH', path: '/patients/:param' },
      ),
    ).toBe(false);
  });

  it('treats :param as a wildcard segment', () => {
    expect(
      routeMatches(
        { method: 'GET', path: '/patients/:param' },
        { method: 'GET', path: '/patients/:param' },
      ),
    ).toBe(true);
    expect(
      routeMatches(
        { method: 'GET', path: '/patients/abc' },
        { method: 'GET', path: '/patients/:param' },
      ),
    ).toBe(true);
  });

  it('requires the same number of segments', () => {
    expect(
      routeMatches(
        { method: 'GET', path: '/patients/:param/notes' },
        { method: 'GET', path: '/patients/:param' },
      ),
    ).toBe(false);
  });
});

describe('bestRouteMatch', () => {
  const routes = [
    { id: 'a', method: 'GET', path: '/patients/:param' },
    { id: 'b', method: 'GET', path: '/patients/stats' },
  ];

  it('prefers the literal route over the parameterised one', () => {
    expect(bestRouteMatch({ method: 'GET', path: '/patients/stats' }, routes)?.id).toBe('b');
  });

  it('falls back to the parameterised route', () => {
    expect(bestRouteMatch({ method: 'GET', path: '/patients/:param' }, routes)?.id).toBe('a');
  });

  it('returns undefined when nothing matches', () => {
    expect(bestRouteMatch({ method: 'DELETE', path: '/patients/1' }, routes)).toBeUndefined();
  });
});
