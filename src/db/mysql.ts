import mysql from "mysql2/promise";
import "dotenv/config";

export const getConnection = async () => {
  return await mysql.createConnection({
    host: "localhost", // está en la misma instancia
    user: "nachobot",
    password: "supersecreta",
    database: process.env.DB_NAME, // o el nombre que tenga tu base
  });
};
