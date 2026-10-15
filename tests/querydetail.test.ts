import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { queryDetail } from '@flowslens/core';

/**
 * One line per query, so six reads of two collections run side by side are
 * six different steps: where the result goes, its filter, order and size.
 */

function details(code: string): string[] {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('q.ts', code);
  const queries = /\.(?:find|findOne|countDocuments|aggregate|updateOne|insertOne|distinct)$/;
  return file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => queries.test(call.getExpression().getText()))
    .map((call) => queryDetail(call) ?? '');
}

describe('queryDetail', () => {
  it('tells the queries of a Promise.all apart by where each result goes', () => {
    expect(
      details(`
        async function stats(ownerId, dayStart) {
          const [rollup, recentlyAdded, today] = await Promise.all([
            medicines.aggregate([{ $match: { ownerId } }, { $facet: { totals: [], categories: [] } }]).next(),
            medicines.find({ ownerId }).sort({ createdAt: -1 }).limit(5).toArray(),
            movements.countDocuments({ ownerId, createdAt: { $gte: dayStart } }),
          ]);
        }`),
    ).toEqual([
      '→ rollup · pipeline $match → $facet (totals, categories)',
      '→ recentlyAdded · where ownerId · newest createdAt first · up to 5',
      '→ today · counts where ownerId, createdAt (range)',
    ]);
  });

  it('says what a lookup filters on, keeps, and what an update changes', () => {
    expect(
      details(`
        async function run(key, ids, id) {
          const docs = await db.collection("settings").find({ phone: { $regex: key } }, { projection: { name: 1 } }).toArray();
          const one = await users.findOne({ _id: { $in: ids } });
          await stock.updateOne({ _id: id }, { $set: { name: "x" }, $inc: { count: 1 } });
          return items.find(filter).sort({ name: 1 });
        }`),
    ).toEqual([
      '→ docs · where phone (matches text) · only name',
      '→ one · where _id (one of a list)',
      'where _id · sets name · adds to count',
      '→ returned · where `filter` · by name',
    ]);
  });
});
