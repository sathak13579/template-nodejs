const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const schedule = require("node-schedule");
const base64 = require("base64-js");
const bodyParser = require("body-parser");
const http = require("http");
const socketIO = require("socket.io");

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 3000;
const dbUrl =
  "mongodb+srv://faizal:KvVBYHQcYdAvthHs@cluster0.me6mrpl.mongodb.net/";
const cors = require("cors");

const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
  },
});
io.on("connection", (socket) => {
  console.log("A client connected");

  // Handle custom events from the client
  socket.on("slackMessageSent", (data) => {
    // Handle the event here
    console.log("Slack message sent:", data);
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("A client disconnected");
  });
});

const userSchema = new mongoose.Schema({
  name: String,
  jiraApiToken: String,
  email: String,
  isAbsent: {
    type: Boolean,
    default: false,
  },
  gitlabToken: String,
});

const settingsSchema = new mongoose.Schema({
  time: {
    type: String,
    required: true,
  },
  slackUrl: {
    type: String,
    required: true,
  },
});

const User = mongoose.model("User", userSchema);
const Settings = mongoose.model("schedule-setting", settingsSchema);
let jobSchedule;

mongoose
  .connect(dbUrl, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((error) => {
    console.error("Failed to connect to MongoDB:", error);
  });

app.use(cors());

app.get("/users", async (req, res) => {
  try {
    const users = await User.find({});
    const settings = await Settings.findOne({});
    res.json({ users, settings });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post("/add-user", async (req, res) => {
  try {
    const { name, jiraApiToken, email, gitlabToken } = req.body.user;
    const user = new User({
      name,
      jiraApiToken,
      email,
      gitlabToken,
      isAbsent: false,
    });

    await user.save();

    res.json(user);
  } catch (error) {
    console.error("Failed to add user:", error);
    res.status(500).json({ error: "Failed to add user" });
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    user.isAbsent = req.body.isAbsent;
    await user.save();
    res.json(user);
  } catch (error) {
    console.error("Failed to update user:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

app.put("/settings", async (req, res) => {
  try {
    const { slackUrl = "", time = "" } = req.body;
    const updatedSettings = {
      slackUrl: slackUrl || "",
      time: time || "",
    };

    const update = await Settings.updateOne({}, updatedSettings);

    res.json({ message: "Successfully updated" });

    if (jobSchedule) {
      jobSchedule.cancel();
    }

    startJob();
  } catch (err) {
    console.log(err);
  }
});

app.get("/gitlab", async (req, res) => {
  try {
    const token = req.query.token;
    const url = `https://gitlab.com/api/v4/merge_requests?private_token=${token}&state=opened`;

    const response = await axios.get(url);
    console.log(response.status);
    const data = response.data.map((mergeRequest) => ({
      id: mergeRequest.id,
      iid: mergeRequest.iid,
      title: mergeRequest.title,
      project_id: mergeRequest.project_id,
      target_branch: mergeRequest.target_branch,
      url: mergeRequest.web_url,
      author: mergeRequest.author.name,
      project: mergeRequest.references.full,
    }));
    res.json(data);
  } catch (error) {
    console.error("Failed to fetch gitlab details:", error);
    res.status(500).json({ error: "Failed to fetch gitlab details" });
  }
});

app.get("/gitlab/changes", async (req, res) => {
  try {
    const { projectId, iid, token } = req.query;
    const url = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${iid}/diffs`;

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    const response = await axios.get(url, { headers });

    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch gitlab details:", error);
    res.status(500).json({ error: "Failed to fetch gitlab details" });
  }
});

app.post("/review", async (req, res) => {
  try {
    const data = req.body;
    stringifiedData = JSON.stringify(data);
    const apiKey = "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";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      stringifiedData,
      { headers }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch gitlab details:", error);
    res.status(500).json({ error: "Failed to fetch gitlab details" });
  }
});

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

async function fetchJiraData(user) {
  try {
    const jiraUrl =
      'https://digidesktop.atlassian.net/rest/api/3/search?jql=(status WAS "In Progress" AFTER -12h) AND assignee  = currentUser() OR status changed AFTER -12h AND status not in ("PROD QA", Issues, Done) AND assignee = currentUser()';
    const authString = base64.fromByteArray(
      Buffer.from(`${user.email}:${user.jiraApiToken}`)
    );

    const headers = {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/json",
    };

    const response = await axios.get(jiraUrl, { headers });
    console.log(response.status);

    if (response.status !== 200) {
      console.log(
        `Failed to get data for user ${user.name}, status code: ${response.status}`
      );
      return [];
    }

    const issues = response.data.issues || [];

    if (issues.length === 0) {
      return ["No tasks Found."];
    }

    return issues.map(
      (issue) =>
        `worked on <https://digidesktop.atlassian.net/browse/${issue.key}|${issue.key}> - ${issue.fields.summary} - *${issue.fields.status.name}*`
    );
  } catch (error) {
    console.error(`Failed to get data for user ${user.name}:`, error);
    return [];
  }
}

async function processUsers() {
  try {
    const users = await User.find({}).exec();

    const allTaskResults = [];

    for (const user of users) {
      console.log(`Processing user ${user.name}`);

      //   if user is absent then let taskResults = "Leave"
      if (user?.isAbsent) {
        user.isAbsent = false;
        await user.save();
        const taskResults = `> *LEAVE*`;
        const text = `*${user.name}'s update:*\n${taskResults}`;
        allTaskResults.push(text);
        continue;
      }
      const jiraData = await fetchJiraData(user);
      const taskResults = jiraData.map((task) => `> ${task}`).join("\n");
      const text = `*${user.name}'s update:*\n${taskResults}`;

      allTaskResults.push(text);
    }

    await sendSlackMessage(allTaskResults);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

async function sendSlackMessage(taskResults) {
  try {
    const settings = await Settings.findOne({});
    const { slackUrl = "" } = settings;

    const currentDate = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const finalText = `*${currentDate}*:\n\n${taskResults.join("\n")}`;
    const payload = { text: finalText };

    const response = await axios.post(slackUrl, payload);
    if (response.status !== 200) {
      console.log(
        `Failed to send message to Slack, status code: ${response.status}`
      );
    }
    io.emit("slackMessageSent");
  } catch (error) {
    console.error("Failed to send message to Slack:", error);
  }
}

async function startJob() {
  const settings = await Settings.findOne({});
  const { time = "" } = settings;
  jobSchedule = schedule.scheduleJob(time, processUsers);
}

startJob();

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
