const Database = require("better-sqlite3");

class PostRateLimiter {
  constructor(dbPath = "./rate_limit.db") {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_log (
        id INTEGER PRIMARY KEY,
        posted_at INTEGER,
        importance_score INTEGER,
        title TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_posted_at ON post_log(posted_at);
    `);
  }

  /**
   * Check if bot should attempt posting
   * @param {number} importantCount - number of CRITICAL/HIGH articles (score >= 7)
   * @returns {object} { shouldPost, reason, maxPostsAllowed }
   */
  canPost(importantCount = 0) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;

    // Count posts in different time windows
    const postsLastHour = this.db
      .prepare("SELECT COUNT(*) as count FROM post_log WHERE posted_at > ?")
      .get(oneHourAgo).count;

    const postsLast2Hours = this.db
      .prepare("SELECT COUNT(*) as count FROM post_log WHERE posted_at > ?")
      .get(twoHoursAgo).count;

    const avgImportanceLastHour = this.db
      .prepare("SELECT AVG(importance_score) as avg FROM post_log WHERE posted_at > ?")
      .get(oneHourAgo).avg || 0;

    // Decision logic
    if (postsLastHour >= 2) {
      // Already posted 2 in last hour
      if (importantCount > 0 && avgImportanceLastHour < 8) {
        // Allow 3rd post only if VERY CRITICAL (score 9-10) and last posts weren't critical
        return {
          shouldPost: false,
          reason: "Rate limit: 2 posts/hour reached. Need score 9+ for extra post.",
          maxPostsAllowed: 0,
          nextEligibleAt: oneHourAgo + 60 * 60 * 1000,
        };
      }
      return {
        shouldPost: false,
        reason: "Rate limit: 2 posts/hour reached.",
        maxPostsAllowed: 0,
        nextEligibleAt: oneHourAgo + 60 * 60 * 1000,
      };
    }

    if (postsLastHour === 1) {
      // Posted 1 in last hour, can post 1 more
      return {
        shouldPost: true,
        reason: "Can post 1 more this hour (1/2 slots used)",
        maxPostsAllowed: 1,
      };
    }

    // No posts in last hour
    if (postsLast2Hours === 0) {
      // No posts in 2 hours - safe to post
      return {
        shouldPost: true,
        reason: "No posts in 2 hours. Safe to post.",
        maxPostsAllowed: importantCount > 0 ? 2 : 1,
      };
    }

    // 1-2 posts in last 2 hours but not in last hour
    if (postsLast2Hours >= 1 && postsLastHour === 0) {
      const lastPost = this.db
        .prepare("SELECT posted_at FROM post_log ORDER BY posted_at DESC LIMIT 1")
        .get();

      const hoursSinceLastPost = (now - lastPost.posted_at) / (60 * 60 * 1000);

      if (hoursSinceLastPost >= 2) {
        return {
          shouldPost: true,
          reason: `${hoursSinceLastPost.toFixed(1)} hours since last post. Can post 1.`,
          maxPostsAllowed: 1,
        };
      }

      return {
        shouldPost: false,
        reason: `Only ${hoursSinceLastPost.toFixed(1)} hours since last post. Need 2+ hours.`,
        maxPostsAllowed: 0,
        nextEligibleAt: lastPost.posted_at + 2 * 60 * 60 * 1000,
      };
    }

    return {
      shouldPost: true,
      reason: "Default: can post",
      maxPostsAllowed: 1,
    };
  }

  /**
   * Record a successful post
   * @param {string} title - article title
   * @param {number} importanceScore - 1-10 score
   */
  recordPost(title, importanceScore) {
    const stmt = this.db.prepare(
      "INSERT INTO post_log (posted_at, importance_score, title) VALUES (?, ?, ?)"
    );
    stmt.run(Date.now(), importanceScore, title);
  }

  /**
   * Get posting stats for logging
   * @returns {object} stats
   */
  getStats() {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const hourly = this.db
      .prepare("SELECT COUNT(*) as count FROM post_log WHERE posted_at > ?")
      .get(oneHourAgo).count;

    const daily = this.db
      .prepare("SELECT COUNT(*) as count FROM post_log WHERE posted_at > ?")
      .get(oneDayAgo).count;

    const lastPost = this.db
      .prepare("SELECT posted_at, title FROM post_log ORDER BY posted_at DESC LIMIT 1")
      .get();

    return {
      postsLastHour: hourly,
      postsLastDay: daily,
      lastPost: lastPost
        ? {
            timeAgo: `${((now - lastPost.posted_at) / 60000).toFixed(0)} min`,
            title: lastPost.title.substring(0, 50),
          }
        : "Never",
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = PostRateLimiter;
