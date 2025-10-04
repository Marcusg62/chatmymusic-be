import 'dotenv/config'; // or: require('dotenv').config();
import helmet from "helmet";
import express, { Request, Response, NextFunction } from "express";
import "express-async-errors";

export function logRequest(req: Request, res: Response, next: NextFunction) {
  console.log("--- Incoming Request ---");
  console.log(`${req.method} ${req.originalUrl}`);
  //   console.log('Authorization header:', req.headers.authorization);
  //   console.log('Headers:', req.headers);
  console.log("Body:", req.body);
  next();
}

// Init express
const app = express();
app.use(express.json()); // <- Needed to parse JSON bodies
app.use(logRequest);
app.use(express.urlencoded({ extended: true }));

// Show routes called in console during development
// if (process.env.NODE_ENV === 'development') {
//     app.use(morgan('dev'));
// }

// Security
if (process.env.NODE_ENV === "production") {
  app.use(helmet());
}

// hello world
app.get("/hi", (req, res) => {
  res.status(200).send("Hello World!");
});


// Export express instance
export default app;
