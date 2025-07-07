import mysql from "mysql2/promise";
import "dotenv/config";
export const getConnection = async () => {
    return await mysql.createConnection({
        host: "localhost",
        user: "nachobot",
        password: "supersecreta",
        database: process.env.DB_NAME,
    });
};
