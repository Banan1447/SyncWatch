// Configuration file for SyncWatch
// Define paths and server settings here

module.exports = {
  // Path to the directory where videos are stored (if applicable)
  videoDirectory: './videos', // Change this if videos are stored elsewhere

  // Port on which the server will run
  port: process.env.PORT || 5000, // Default to 3000, can be overridden by environment variable
};
</contents>