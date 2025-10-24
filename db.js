import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  user: "huertoesp_user", // tu usuario
  host: "dpg-d3tom7mr433s73ds2thg-a", //solo el host, no la URL completa
  database: "huertoesp", // tu base de datos
  password: "9yVvR0VHaDh3EaAZ3PtmCuLoZd0f9mgA",
  port: 5432, // por defecto
});

export default pool;
