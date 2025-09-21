const { Pool } = require('pg');

const pool = new Pool({
  user: 'admin',      // 👈 tu usuario
  host: 'postgresql://admin:mZKFQKsmoFidHwJpf6hKakSb4F6480IW@dpg-d384afggjchc73cotpa0-a/huerto',     // o la URL de Render
  database: 'huerto',// 👈 tu base de datos
  password: 'mZKFQKsmoFidHwJpf6hKakSb4F6480IW',
  port: 5432,            // por defecto
});

module.exports = pool;
