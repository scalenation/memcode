export function createD1Client(binding) {
  if (!binding) {
    throw new Error('Missing D1 binding: DB');
  }

  return {
    async all(sql, params = []) {
      const result = await binding.prepare(sql).bind(...params).all();
      return {
        rows: result.results ?? [],
        rowCount: (result.results ?? []).length,
        meta: result.meta ?? null,
      };
    },

    async first(sql, params = []) {
      return binding.prepare(sql).bind(...params).first();
    },

    async run(sql, params = []) {
      return binding.prepare(sql).bind(...params).run();
    },

    async value(sql, params = []) {
      const row = await binding.prepare(sql).bind(...params).first();
      if (!row) return null;
      const values = Object.values(row);
      return values.length > 0 ? values[0] : null;
    },
  };
}