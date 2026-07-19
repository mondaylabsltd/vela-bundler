use std::error::Error;

pub type AppError = Box<dyn Error + Send + Sync>;
