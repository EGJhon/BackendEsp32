import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  user: "admin", // 👈 tu usuario
  host: "dpg-d384afggjchc73cotpa0-a", // 👈 solo el host, no la URL completa
  database: "huerto", // 👈 tu base de datos
  password: "mZKFQKsmoFidHwJpf6hKakSb4F6480IW",
  port: 5432, // por defecto
});

export default pool;
