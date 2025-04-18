import mysql from "mysql2/promise";

export const getConnection = async () => {
  return await mysql.createConnection({
    host: "localhost", // está en la misma instancia
    user: "nachobot",
    password: "supersecreta",
    database: "P8", // o el nombre que tenga tu base
  });
};
