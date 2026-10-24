import { afterEach } from "vitest";
import { removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);
