// SQL reporting policy shared by the application and its checks.
export async function validateCartaSql(sql, queryConnection, views) {
  if (!sql || sql === "UNSUPPORTED_QUERY") {
    throw new Error(
      "Only questions about CARTA datasets (bus routes, stops, vehicle locations, predictions, trip delays, ridership, bike stations, parcels, or addresses) are supported."
    );
  }

  if (typeof sql !== "string" || sql.length > 50000) throw new Error("The SQL query is too long.");
  // Bind SQL as a value. Serialization parses it without binding tables or executing it.
  const statement = await queryConnection.prepare("SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast");
  let parsed;
  try {
    const result = await statement.query(sql);
    parsed = JSON.parse(result.toArray()[0].ast);
  } finally {
    await statement.close();
  }
  const usesSpatial = validateCartaSqlAst(parsed, views);
  // Wasm downloads and loads this fixed extension on demand. Only validated
  // spatial functions trigger it; report SQL cannot INSTALL or LOAD anything.
  if (usesSpatial) await queryConnection.query("LOAD spatial");
  return parsed;
}

export function validateCartaSqlAst(parsed, views) {
  if (parsed?.error || !Array.isArray(parsed?.statements) || parsed.statements.length !== 1) {
    throw new Error("Run one valid read-only SELECT query on CARTA datasets.");
  }
  const allowedViews = new Set(views.map((view) => view.toLowerCase()));
  const allowedFunctions = new Set([
    "+", "-", "*", "/", "//", "%", "**", "^", "||", "~~", "!~~", "~~*", "!~~*", "ilike_escape",
    "abs", "round", "ceil", "ceiling", "floor", "sqrt", "pow", "power", "sign",
    "sum", "avg", "count", "count_star", "min", "max", "median", "mode", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
    "first", "last", "any_value", "arg_min", "arg_max", "string_agg", "list", "array_agg", "bool_and", "bool_or", "approx_count_distinct",
    "lower", "upper", "length", "char_length", "trim", "ltrim", "rtrim", "replace", "substring", "substr", "left", "right", "concat", "concat_ws", "starts_with", "ends_with", "contains", "regexp_matches", "regexp_replace", "split_part",
    "nullif", "coalesce", "ifnull", "if", "greatest", "least",
    "date_part", "date_trunc", "date_diff", "date_sub", "date_add", "strftime", "strptime", "try_strptime", "epoch", "epoch_ms", "to_timestamp", "make_date", "make_timestamp", "year", "month", "day", "dayofweek", "dayname", "monthname", "quarter", "week", "last_day", "current_date", "current_timestamp", "now", "timezone",
    "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value",
    "st_distance", "st_distance_sphere", "st_dwithin", "st_intersects", "st_contains", "st_within", "st_x", "st_y", "st_astext", "st_asgeojson", "st_point", "st_geomfromtext", "st_transform", "st_area", "st_length", "st_centroid"
  ]);
  const allowedExpressions = new Set(["CONSTANT", "COLUMN_REF", "STAR", "CAST", "CASE", "COMPARISON", "CONJUNCTION", "OPERATOR", "FUNCTION", "WINDOW", "SUBQUERY", "BETWEEN", "COLLATE", "LAMBDA", "TYPE"]);
  let visited = 0;
  let usesSpatial = false;
  const reject = (message) => { throw new Error(message); };
  const checkSize = () => { if (++visited > 10000) reject("The SQL query is too complex."); };

  function inspectValue(value, scope) {
    checkSize();
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      let readsCarta = false;
      for (const child of value) readsCarta = inspectValue(child, scope) || readsCarta;
      return readsCarta;
    }
    if (typeof value.type === "string" && value.type.endsWith("_NODE")) return inspectQuery(value, scope);
    if (!value.class && ["BASE_TABLE", "SUBQUERY", "JOIN", "CROSS_PRODUCT", "EMPTY", "TABLE_FUNCTION"].includes(value.type)) return inspectTable(value, scope);
    if (value.class && !allowedExpressions.has(value.class)) reject(`Unsupported SQL expression: ${value.class}.`);
    if (value.class === "FUNCTION" || value.class === "WINDOW") {
      const schema = (value.schema || "").toLowerCase();
      const path = value.qualified_name?.path;
      const builtinPath = !path || path.length === 1 || (path.length === 2 && path[0].toLowerCase() === "main");
      // Older parsers qualify EXTRACT's date_part function with the built-in main schema.
      if (!["", "main"].includes(schema) || value.catalog || !builtinPath || !allowedFunctions.has(value.function_name?.toLowerCase())) {
        reject(`Function is not permitted in CARTA reports: ${value.function_name || "unknown"}.`);
      }
      if (value.function_name.toLowerCase().startsWith("st_")) usesSpatial = true;
    }
    let readsCarta = false;
    for (const child of Object.values(value)) readsCarta = inspectValue(child, scope) || readsCarta;
    return readsCarta;
  }

  function resolveCte(cte) {
    if (cte.resolving) reject("Recursive CTEs are not supported in CARTA reports.");
    if (cte.checked) return cte.readsCarta;
    cte.resolving = true;
    cte.readsCarta = inspectQuery(cte.node, cte.scope);
    cte.resolving = false;
    cte.checked = true;
    return cte.readsCarta;
  }

  function inspectTable(table, scope) {
    checkSize();
    if (!table || typeof table !== "object") reject("Unsupported SQL data source.");
    if (table.type === "BASE_TABLE") {
      if (table.at_clause) reject("Historical table references are not supported.");
      const name = table.table_name?.toLowerCase();
      const schema = (table.schema_name || "").toLowerCase();
      const catalog = (table.catalog_name || "").toLowerCase();
      let readsCarta;
      if (!schema && !catalog && scope.has(name)) readsCarta = resolveCte(scope.get(name));
      else if (allowedViews.has(name) && ((!catalog && schema === "data") || (catalog === "data" && schema === "main"))) readsCarta = true;
      else reject("Every table must be an available CARTA dataset (data.<view>) or a CTE derived from permitted sources.");
      for (const value of Object.values(table)) inspectValue(value, scope);
      return readsCarta;
    }
    if (table.type === "EMPTY") return false;
    if (table.type === "SUBQUERY") {
      let readsCarta = false;
      for (const value of Object.values(table)) readsCarta = inspectValue(value, scope) || readsCarta;
      return readsCarta;
    }
    if (table.type === "JOIN" || table.type === "CROSS_PRODUCT") {
      let readsCarta = inspectTable(table.left, scope);
      readsCarta = inspectTable(table.right, scope) || readsCarta;
      for (const [key, value] of Object.entries(table)) {
        if (key !== "left" && key !== "right") readsCarta = inspectValue(value, scope) || readsCarta;
      }
      return readsCarta;
    }
    reject("Table functions, external files, and this SQL data-source syntax are not permitted.");
  }

  function inspectQuery(node, inheritedScope = new Map()) {
    checkSize();
    if (!node || !["SELECT_NODE", "SET_OPERATION_NODE"].includes(node.type)) reject("Only SELECT queries and non-recursive reporting CTEs are supported.");
    const scope = new Map(inheritedScope);
    const entries = node.cte_map?.map || [];
    if (!Array.isArray(entries)) reject("Unsupported CTE structure.");
    const definitions = [];
    for (const entry of entries) {
      const queryNode = entry.value?.query_node || entry.value?.query?.node;
      if (typeof entry.key !== "string" || !queryNode) reject("Unsupported CTE structure.");
      const cte = { node: queryNode, scope, checked: false, resolving: false };
      scope.set(entry.key.toLowerCase(), cte);
      definitions.push(cte);
    }
    // Inspect even unused CTEs, but count their sources only if the query actually refers to them.
    for (const cte of definitions) resolveCte(cte);
    let readsCarta = false;
    if (node.type === "SET_OPERATION_NODE") {
      const branches = node.children || [node.left, node.right];
      if (!Array.isArray(branches) || branches.length < 2) reject("Unsupported set operation.");
      for (const branch of branches) {
        if (!inspectQuery(branch, scope)) reject("Every UNION, INTERSECT, or EXCEPT branch must query CARTA datasets.");
      }
      readsCarta = true;
    } else {
      readsCarta = inspectTable(node.from_table, scope);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!["cte_map", "from_table", "children", "left", "right"].includes(key)) readsCarta = inspectValue(value, scope) || readsCarta;
    }
    return readsCarta;
  }

  if (!inspectQuery(parsed.statements[0].node)) reject("The query must read a CARTA dataset; comments, literals, and unused CTEs do not count as data sources.");
  return usesSpatial;
}
