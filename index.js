const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

// --- Firebase Admin Initialization ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT:", err.message);
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require("./plantKey.json");
  } catch (err) {
    console.error("plantKey.json not found. Auth disabled.");
    serviceAccount = null;
  }
}

if (serviceAccount && admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin initialized");
}

// --- CORS Configuration ---
const FRONTEND_URLS = process.env.FRONTEND_URLS || "http://localhost:5173,http://localhost:5174,https://spontaneous-clafoutis-c5c9c8.netlify.app";
const allowedOrigins = FRONTEND_URLS.split(",").map((u) => u.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        return callback(null, true);
      }
      return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

app.use(express.json());

// --- MongoDB Configuration ---

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.5u4x9tc.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

// --- Auth Middleware ---
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized: No token provided" });
    }
    const idToken = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
}

async function run() {
  try {
    await client.connect();
    console.log("✅ MongoDB Connected Successfully!");

    const db = client.db("car");
    const carsCollection = db.collection("car-plant");
    const bookingsCollection = db.collection("bookings");
    const usersCollection = db.collection("users");

    app.get("/", (req, res) => res.send("Car Rental Server Running!"));

    // ---  USER & ADMIN MANAGEMENT APIs ---

    app.put("/api/users", verifyToken, async (req, res) => {
      const user = req.body;
      const filter = { email: user.email };
      const updateDoc = { $set: user };
      const result = await usersCollection.updateOne(filter, updateDoc, { upsert: true });
      res.json(result);
    });

    app.get("/api/users", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Forbidden: Admin Only" });
      const result = await usersCollection.find().toArray();
      res.json(result);
    });

    app.delete("/api/admin/users/:id", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Forbidden" });
      const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    app.patch("/api/users/make-admin", verifyToken, async (req, res) => {
      const { secretKey, email } = req.body;
      const ADMIN_EMAIL = "admin@gmail.com"; 
      const ADMIN_SECRET_KEY = "Sabbir@1234"; 

      if (email !== ADMIN_EMAIL) return res.status(403).json({ success: false, message: "Unauthorized email." });
      if (secretKey !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false, message: "Invalid Key!" });

      const result = await usersCollection.updateOne({ email }, { $set: { role: "admin" } }, { upsert: true });
      res.json({ success: true, message: "Success! You are now an Admin." });
    });

    app.get("/api/users/role/:email", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.json({ role: user?.role || "user" });
    });

    // --- 🚗 CAR APIs ---


    app.post("/api/cars", verifyToken, async (req, res) => {
      const car = req.body;
      car.providerEmail = req.user.email;
      car.status = "available";
      car.createdAt = new Date(); 
      const result = await carsCollection.insertOne(car);
      res.status(201).json({ message: "Car added!", id: result.insertedId });
    });

    app.put("/api/cars/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedCar = req.body;
        
        delete updatedCar._id; 
        delete updatedCar.providerEmail;

        const updateDoc = {
          $set: {
            ...updatedCar,
            price: Number(updatedCar.price)
          },
        };

        const result = await carsCollection.updateOne(filter, updateDoc);
        res.json(result);
      } catch (error) {
        console.error("Error updating car:", error);
        res.status(500).json({ message: "Update failed" });
      }
    });


    app.delete("/api/cars/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id), providerEmail: req.user.email };
        
        const result = await carsCollection.deleteOne(query);
        
        if (result.deletedCount === 0) {
          return res.status(403).json({ message: "Forbidden: You can only delete your own cars." });
        }
        
        res.json(result);
      } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ message: "Failed to delete car" });
      }
    });

    app.delete("/api/admin/cars/:id", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Admin Only" });
      const result = await carsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    // ৫. Top Rated
    app.get("/api/cars/top-rated", async (req, res) => {
      const cars = await carsCollection.find({}).sort({rating: -1}).limit(20).toArray();
      res.json(cars);
    });

    // ৬. Top Browse
    app.get("/api/cars/top-browse", async (req, res) => {
      try {
        const result = await carsCollection
            .find({})
            .sort({ createdAt: -1 })
            .limit(28) 
            .toArray();
            
        res.json(result);
      } catch (error) {
        res.status(500).json({ message: "Error fetching cars" });
      }
    });

    // ৭. My Listings
    app.get("/api/car/my-listings", verifyToken, async (req, res) => {
      const cars = await carsCollection.find({ providerEmail: req.user.email }).toArray();
      res.json(cars);
    });

    // ৮. Admin All Cars
    app.get("/api/admin/all-cars", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Admin Only" });
      const result = await carsCollection.find().toArray();
      res.json(result);
    });

    // ৯. Single Car Details 
    
    app.get("/api/cars/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.status(400).send("Invalid ID");
        }
        const query = { _id: new ObjectId(id) };
        const result = await carsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        res.status(404).send("Car not found");
      }
    });

    // ---  BOOKING APIs ---

    app.delete("/api/admin/bookings/:id", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Admin Only" });
      const result = await bookingsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    app.delete("/api/bookings/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      
      const booking = await bookingsCollection.findOne(query);
      if (!booking) return res.status(404).json({ message: "Booking not found" });

      const result = await bookingsCollection.deleteOne(query);
      
      if (booking.carId) {
        await carsCollection.updateOne(
          { _id: new ObjectId(booking.carId) }, 
          { $set: { status: "available" } }
        );
      }
      res.json(result);
    });

    app.post("/api/cars/:id/book", verifyToken, async (req, res) => {
      const car = await carsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!car || car.status === "booked") return res.status(400).json({ message: "Unavailable" });
      const bookingData = { carId: car._id, userEmail: req.user.email, bookedAt: new Date(), name: car.name, pricePerDay: car.price, image: car.imageUrl };
      await bookingsCollection.insertOne(bookingData);
      await carsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "booked" } });
      res.json({ message: "Booked!" });
    });

    app.get("/api/my-bookings", verifyToken, async (req, res) => {
      const result = await bookingsCollection.find({ userEmail: req.user.email }).toArray();
      res.json(result);
    });

    app.get("/api/admin/all-bookings", verifyToken, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.user.email });
      if (adminUser?.role !== "admin") return res.status(403).json({ message: "Admin Only" });
      const result = await bookingsCollection.find().toArray();
      res.json(result);
    });

  
    app.get("/api/dashboard/stats", verifyToken, async (req, res) => {
      const email = req.user.email;
      const user = await usersCollection.findOne({ email });

      if (user?.role === "admin") {
        const totalCars = await carsCollection.countDocuments();
        const totalBookings = await bookingsCollection.countDocuments();
        const totalUsers = await usersCollection.countDocuments(); 
        const activeRentals = await carsCollection.countDocuments({ status: "booked" });
        const availableCars = await carsCollection.countDocuments({ status: "available" });
        res.json({ myListings: totalCars, activeRentals, availableCars, myBookings: totalBookings, totalUsers });
      } else {
        
        const myListings = await carsCollection.countDocuments({ providerEmail: email });
    
        const activeRentals = await carsCollection.countDocuments({ providerEmail: email, status: "booked" });
        const availableCars = await carsCollection.countDocuments({ providerEmail: email, status: "available" });
        const myBookings = await bookingsCollection.countDocuments({ userEmail: email });
        
        res.json({ myListings, activeRentals, availableCars, myBookings });
      }
    });

    console.log("🚀 Server ready with Full Admin Controls!");
  } catch (error) {
    console.error("Error:", error);
  }
}

run().catch(console.error);
app.listen(port, () => console.log(`🚀 Port: ${port}`));